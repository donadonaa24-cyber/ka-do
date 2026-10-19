import { useLayoutEffect, useRef, useState } from 'react';
import { type Ctx, findLocation } from '../engine/game';
import type { CardInstance, GameState, LinkMarker, Location } from '../engine/types';
import { CardView } from './CardView';

// カードの移動（サーチ・ドロー・捨てる・コスト・召喚など）を、移動元から移動先へ飛ばして見せる演出

type Rect = { x: number; y: number; w: number; h: number };

/** 召喚などの演出の種類（色・動きが変わる） */
export type BurstKind =
  | 'normal'
  | 'advance'
  | 'set'
  | 'special'
  | 'extra'
  | 'fusion'
  | 'synchro'
  | 'xyz'
  | 'link'
  | 'ritual'
  | 'activate'
  | 'destroy'
  | 'banish'
  | 'release';

interface Flight {
  id: number;
  uid: string;
  from: Rect;
  to: Rect;
  delay: number;
  label: string;
  /** 移動中に見せる表裏 */
  inst: CardInstance;
  defId: string;
  /** 着地点に出す演出 */
  burst?: BurstKind;
  /** 移動元に出す演出（破壊・除外など） */
  leave?: BurstKind;
  /** 飛ばさずに、その場に現れる（EXデッキからの召喚の演出の後） */
  appear?: boolean;
}

interface Burst {
  id: number;
  kind: BurstKind;
  at: Rect;
  delay: number;
  label?: string;
  /** 召喚したカード（演出の間、そのカードの位置に合わせる） */
  uid?: string;
  /** リンク召喚：出すモンスターのリンクマーカー */
  arrows?: LinkMarker[];
  /** 相手のカード（向きが逆） */
  mirror?: boolean;
}

const FLIGHT_MS = 560;
const APPEAR_MS = 520;
const STAGGER_MS = 140;

/** 融合・シンクロ・エクシーズ・リンク・儀式召喚は、演出を見せてからカードが現れる */
const PRELUDE_MS: Partial<Record<BurstKind, number>> = {
  fusion: 1100,
  synchro: 900,
  xyz: 1150,
  link: 1100,
  ritual: 1200,
};

/** 召喚・移動の演出：常に出す／端末の「アニメーションを減らす」設定に合わせる／出さない */
export type MotionMode = 'on' | 'auto' | 'off';
const MOTION_KEY = 'ygo-motion';

export function loadMotionMode(): MotionMode {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    return v === 'auto' || v === 'off' ? v : 'on';
  } catch {
    return 'on';
  }
}

export function saveMotionMode(mode: MotionMode) {
  try {
    localStorage.setItem(MOTION_KEY, mode);
  } catch {
    // 保存できなくても今の画面では使える
  }
}

const reduceMotion = () => {
  const mode = loadMotionMode();
  if (mode !== 'auto') return mode === 'off';
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** 今表示しているカード（data-uid）と山札など（data-pile）の位置 */
function measure(root: HTMLElement | null) {
  const cards = new Map<string, Rect>();
  const piles = new Map<string, Rect>();
  if (!root) return { cards, piles };
  root.querySelectorAll<HTMLElement>('[data-uid]').forEach((el) => {
    const r = rectOf(el);
    if (r.w > 0 && el.closest('.modal, .sheet, .route-modal') === null) cards.set(el.dataset.uid!, r);
  });
  root.querySelectorAll<HTMLElement>('[data-pile]').forEach((el) => piles.set(el.dataset.pile!, rectOf(el)));
  return { cards, piles };
}

/** 演出の間に盤面の配置が変わっても（解説が開くなど）、カードの今の位置に合わせる */
function useLiveRect(uid: string | undefined, initial: Rect): Rect {
  const [rect, setRect] = useState(initial);
  useLayoutEffect(() => {
    if (!uid) return;
    let raf = 0;
    const tick = () => {
      const el = [...document.querySelectorAll(`.app [data-uid="${uid}"]`)].find(
        (e) => e.closest('.modal, .sheet, .route-modal') === null,
      );
      if (el) {
        const n = rectOf(el);
        setRect((p) => (Math.abs(p.x - n.x) + Math.abs(p.y - n.y) + Math.abs(p.w - n.w) > 0.5 ? n : p));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [uid]);
  return rect;
}

/** カードの場所を、山札などの名前にする（個々のカードが表示されていない場所の代わりの位置） */
const pileOf = (loc: Location | null): string | null => {
  if (!loc) return null;
  return loc.zone;
};

const onField = (loc: Location | null) =>
  !!loc && ['mz', 'emz', 'stz', 'fz', 'omz', 'oemz', 'ostz', 'ofz'].includes(loc.zone);
const isMonsterZone = (loc: Location | null) => !!loc && ['mz', 'emz', 'omz', 'oemz'].includes(loc.zone);
const sameLoc = (a: Location | null, b: Location | null) =>
  !!a && !!b && a.zone === b.zone && ('index' in a ? a.index : -1) === ('index' in b ? b.index : -1);

const SUMMON_LABEL: Record<string, [BurstKind, string]> = {
  fusion: ['fusion', '融合召喚'],
  synchro: ['synchro', 'シンクロ召喚'],
  xyz: ['xyz', 'エクシーズ召喚'],
  link: ['link', 'リンク召喚'],
  ritual: ['ritual', '儀式召喚'],
};

/** 移動の種類から、表示する言葉と演出を決める */
function describe(
  prev: GameState,
  next: GameState,
  uid: string,
  from: Location | null,
  to: Location,
  advance: boolean,
): { label: string; burst?: BurstKind; leave?: BurstKind } {
  const inst = next.cards[uid];
  const reason = inst.movedReason ?? '';
  const fz = from?.zone;
  if (isMonsterZone(to)) {
    if (!inst.faceUp) return { label: 'セット', burst: 'set' };
    const t = inst.summonType;
    if (t && SUMMON_LABEL[t]) return { label: SUMMON_LABEL[t][1], burst: SUMMON_LABEL[t][0] };
    if (t === 'normal')
      return advance ? { label: 'アドバンス召喚', burst: 'advance' } : { label: '通常召喚', burst: 'normal' };
    if (fz === 'extra') return { label: '特殊召喚（EXデッキから）', burst: 'extra' };
    if (onField(from)) return { label: '移動' };
    const src: Record<string, string> = { hand: '手札', deck: 'デッキ', gy: '墓地', banished: '除外', extra: 'EX' };
    return { label: `特殊召喚${fz && src[fz] ? `（${src[fz]}から）` : ''}`, burst: 'special' };
  }
  if (to.zone === 'stz' || to.zone === 'fz' || to.zone === 'ostz' || to.zone === 'ofz') {
    if (inst.equippedTo) return { label: '装備', burst: 'activate' };
    if (!inst.faceUp) return { label: 'セット', burst: 'set' };
    return { label: inst.pendingResolve ? '発動' : '表側で置く', burst: 'activate' };
  }
  const leaveFx = (): BurstKind | undefined =>
    !onField(from)
      ? undefined
      : /破壊/.test(reason)
        ? 'destroy'
        : /リリース/.test(reason)
          ? 'release'
          : to.zone === 'banished' || to.zone === 'obanished'
            ? 'banish'
            : undefined;
  if (to.zone === 'hand' || to.zone === 'ohand') {
    if (fz === 'deck') return { label: /ドロー/.test(reason) || !reason ? 'ドロー' : 'デッキから手札へ' };
    if (fz === 'gy') return { label: '墓地から手札へ' };
    if (fz === 'banished') return { label: '除外から手札へ' };
    return { label: onField(from) ? '手札に戻る' : '手札へ', leave: leaveFx() };
  }
  if (to.zone === 'gy' || to.zone === 'ogy') {
    const word = /コスト/.test(reason)
      ? 'コストで墓地へ'
      : /リリース/.test(reason)
        ? 'リリース'
        : /破壊/.test(reason)
          ? '破壊'
          : /素材/.test(reason)
            ? '素材で墓地へ'
            : fz === 'hand'
              ? '捨てる'
              : fz === 'deck'
                ? 'デッキから墓地へ'
                : inst.pendingResolve === false && prev.cards[uid]?.pendingResolve
                  ? '処理後に墓地へ'
                  : '墓地へ';
    return { label: word, leave: leaveFx() };
  }
  if (to.zone === 'banished' || to.zone === 'obanished')
    return { label: /コスト/.test(reason) ? 'コストで除外' : '除外', leave: leaveFx() ?? 'banish' };
  if (to.zone === 'deck') return { label: 'デッキに戻る' };
  if (to.zone === 'extra') return { label: 'EXデッキに戻る' };
  return { label: '' };
}

interface Props {
  view: GameState;
  ctx: Ctx;
  /** 演出しない変化（1手戻す・新しいゲーム・効果の取り消し）の時は false */
  animate: boolean;
}

/** 盤面の変化を見て、カードの移動と召喚の演出を重ねて表示する */
export function MotionLayer({ view, ctx, animate }: Props) {
  const prev = useRef<{ state: GameState; cards: Map<string, Rect>; piles: Map<string, Rect> } | null>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const nextId = useRef(1);

  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>('.app');
    const now = measure(root);
    const before = prev.current;
    prev.current = { state: view, ...now };
    if (!before || !animate || before.state === view || reduceMotion()) return;
    const old = before.state;

    // 移動したカードを、移動した順番に並べる
    const moved: { uid: string; from: Location | null; to: Location }[] = [];
    for (const uid of Object.keys(view.cards)) {
      const to = findLocation(view, uid);
      if (!to) continue;
      const from = old.cards[uid] ? findLocation(old, uid) : null;
      if (sameLoc(from, to)) {
        // セットしていたカードを表にした（発動・反転召喚）
        const was = old.cards[uid];
        if (was && !was.faceUp && view.cards[uid].faceUp && onField(to)) {
          const el = root?.querySelector(`[data-uid="${uid}"]`);
          el?.animate([{ transform: 'rotateY(90deg) scale(1.1)' }, { transform: 'rotateY(0deg) scale(1)' }], {
            duration: 420,
            easing: 'ease-out',
          });
          const r = now.cards.get(uid);
          if (r)
            setBursts((b) => [
              ...b,
              {
                id: nextId.current++,
                kind: isMonsterZone(to) ? 'normal' : 'activate',
                at: r,
                delay: 0,
                label: isMonsterZone(to) ? '反転召喚' : '発動',
              },
            ]);
        }
        continue;
      }
      // X素材になったカードなど、表示されていない場所への移動は省く
      moved.push({ uid, from, to });
    }
    if (!moved.length) return;
    moved.sort((a, b) => view.cards[a.uid].movedAt - view.cards[b.uid].movedAt);
    // フィールドからリリースされたモンスターがいれば、同時の通常召喚はアドバンス召喚
    const advance = moved.some((m) => onField(m.from) && /リリース/.test(view.cards[m.uid].movedReason ?? ''));

    const step = Math.min(STAGGER_MS, 900 / moved.length);
    const fl: Flight[] = [];
    const bs: Burst[] = [];
    // EXデッキからの召喚の演出の間は、後のカードの移動を待たせる
    let wait = 0;
    moved.forEach((m, i) => {
      const from = before.cards.get(m.uid) ?? (m.from ? before.piles.get(pileOf(m.from)!) : undefined);
      const to = now.cards.get(m.uid) ?? now.piles.get(pileOf(m.to)!);
      if (!from || !to) return;
      const d = describe(old, view, m.uid, m.from, m.to, advance);
      const inst = view.cards[m.uid];
      const delay = i * step + wait;
      const pre = d.burst ? PRELUDE_MS[d.burst] : undefined;
      if (d.leave) bs.push({ id: nextId.current++, kind: d.leave, at: from, delay });
      if (pre) {
        // 演出 → その場にカードが現れる
        const def = view.tokenDefs[inst.defId] ?? ctx.db[inst.defId];
        bs.push({
          id: nextId.current++,
          kind: d.burst!,
          at: to,
          delay,
          label: d.label,
          uid: m.uid,
          arrows: def?.linkMarkers,
          mirror: m.to.zone.startsWith('o'),
        });
        fl.push({
          id: nextId.current++,
          uid: m.uid,
          from: to,
          to,
          delay: delay + pre - 120,
          label: '',
          inst,
          defId: inst.defId,
          appear: true,
        });
        wait += pre;
        return;
      }
      fl.push({
        id: nextId.current++,
        uid: m.uid,
        from,
        to,
        delay,
        label: d.label,
        burst: d.burst,
        inst,
        defId: inst.defId,
      });
      if (d.burst)
        bs.push({ id: nextId.current++, kind: d.burst, at: to, delay: delay + FLIGHT_MS - 80, label: d.label });
    });
    if (!fl.length && !bs.length) return;
    // 着地するまで、移動先の本物のカードは隠しておく
    for (const f of fl) {
      const el = root?.querySelector<HTMLElement>(`[data-uid="${f.uid}"]`);
      if (!el) continue;
      el.style.visibility = 'hidden';
      window.setTimeout(() => (el.style.visibility = ''), f.delay + (f.appear ? APPEAR_MS : FLIGHT_MS));
    }
    setFlights((x) => [...x, ...fl]);
    if (bs.length) setBursts((b) => [...b, ...bs]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  return (
    <div className="motion-layer" aria-hidden="true">
      {flights.map((f) => (
        <FlightView
          key={f.id}
          f={f}
          ctx={ctx}
          view={view}
          onDone={() => setFlights((x) => x.filter((y) => y.id !== f.id))}
        />
      ))}
      {bursts.map((b) => (
        <BurstView key={b.id} b={b} onDone={() => setBursts((x) => x.filter((y) => y.id !== b.id))} />
      ))}
    </div>
  );
}

function FlightView({ f, ctx, view, onDone }: { f: Flight; ctx: Ctx; view: GameState; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useLiveRect(f.appear ? f.uid : undefined, f.to);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dx = f.from.x + f.from.w / 2 - (f.to.x + f.to.w / 2);
    const dy = f.from.y + f.from.h / 2 - (f.to.y + f.to.h / 2);
    const s = f.to.w ? f.from.w / f.to.w : 1;
    const a = f.appear
      ? el.animate(
          [
            { transform: 'scale(1.6)', opacity: 0, filter: 'brightness(3)' },
            { transform: 'scale(0.94)', opacity: 1, filter: 'brightness(1.7)', offset: 0.6 },
            { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
          ],
          { duration: APPEAR_MS, delay: f.delay, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'both' },
        )
      : el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0.95 },
            {
              transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 28}px) scale(${(s + 1) / 2 + 0.12})`,
              opacity: 1,
              offset: 0.55,
            },
            { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          ],
          { duration: FLIGHT_MS, delay: f.delay, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' },
        );
    a.onfinish = onDone;
    return () => a.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 置く・召喚する前のカードがデッキの中など、もう盤面にない時のために、記録した見た目で表示する
  const def = view.tokenDefs[f.defId] ?? ctx.db[f.defId];
  if (!def) return null;
  return (
    <div
      ref={ref}
      className="flight"
      style={
        {
          left: live.x,
          top: live.y,
          width: live.w,
          height: live.h,
          '--card-w': `${live.w}px`,
          '--card-h': `${live.h}px`,
        } as React.CSSProperties
      }
    >
      <CardView def={def} inst={{ ...f.inst, position: 'atk' }} showFaceDown={false} />
      {f.label && <span className="flight-label">{f.label}</span>}
    </div>
  );
}

function BurstView({ b, onDone }: { b: Burst; onDone: () => void }) {
  if (PRELUDE_MS[b.kind]) return <SummonFx b={b} onDone={onDone} />;
  return <RingBurst b={b} onDone={onDone} />;
}

function RingBurst({ b, onDone }: { b: Burst; onDone: () => void }) {
  useLayoutEffect(() => {
    const t = window.setTimeout(onDone, b.delay + 1100);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const size = Math.max(b.at.w, b.at.h);
  return (
    <div
      className={`burst burst-${b.kind}`}
      style={
        {
          left: b.at.x + b.at.w / 2 - size,
          top: b.at.y + b.at.h / 2 - size,
          width: size * 2,
          height: size * 2,
          animationDelay: `${b.delay}ms`,
          '--delay': `${b.delay}ms`,
        } as React.CSSProperties
      }
    >
      <span className="burst-ring" />
      <span className="burst-ring r2" />
      <span className="burst-glow" />
      {b.label && <span className="burst-label">{b.label}</span>}
    </div>
  );
}

/** リンクマーカーの向き（上が0度） */
const ARROW_ANGLE: Record<LinkMarker, number> = { T: 0, TR: 45, R: 90, BR: 135, B: 180, BL: 225, L: 270, TL: 315 };

/**
 * 融合・シンクロ・エクシーズ・リンク召喚の演出（この後にカードが現れる）
 * 融合：渦を巻いて吸い込む／シンクロ：光の柱がまっすぐ突き抜ける／エクシーズ：黒い靄が集まって爆発／リンク：リンクマーカーが出る
 * 儀式：足元に魔法陣が浮かび、青い炎が立ち上る
 */
function SummonFx({ b, onDone }: { b: Burst; onDone: () => void }) {
  const pre = PRELUDE_MS[b.kind]!;
  useLayoutEffect(() => {
    const t = window.setTimeout(onDone, b.delay + pre + 1000);
    // エクシーズは爆発の瞬間に盤面を揺らす
    const board = b.kind === 'xyz' ? document.querySelector('.board') : null;
    const shake = board?.animate(
      [
        { transform: 'translate(0, 0)' },
        { transform: 'translate(-5px, 3px)' },
        { transform: 'translate(4px, -3px)' },
        { transform: 'translate(-3px, -2px)' },
        { transform: 'translate(0, 0)' },
      ],
      { duration: 320, delay: b.delay + pre - 220 },
    );
    return () => {
      window.clearTimeout(t);
      shake?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const at = useLiveRect(b.uid, b.at);
  const cw = at.w;
  const ch = at.h;
  const size = Math.max(cw, ch) * 3;
  const cx = at.x + cw / 2;
  const cy = at.y + ch / 2;
  const style = {
    left: cx - size / 2,
    top: cy - size / 2,
    width: size,
    height: size,
    '--delay': `${b.delay}ms`,
    '--pre': `${pre}ms`,
    '--cw': `${cw}px`,
    '--ch': `${ch}px`,
  } as React.CSSProperties;
  const corner = Math.hypot(cw / 2, ch / 2);
  return (
    <div className={`summon-fx fx-${b.kind}`} style={style}>
      {b.kind === 'fusion' && (
        <>
          <span className="fx-swirl" />
          <span className="fx-swirl s2" />
          <span className="fx-core" />
        </>
      )}
      {b.kind === 'synchro' && (
        <>
          {/* 光の柱は画面の上下いっぱいに */}
          <span className="fx-beam" style={{ top: -(cy - size / 2), height: window.innerHeight }} />
          <span className="fx-bolt" style={{ top: -(cy - size / 2), height: window.innerHeight }} />
          {[0, 1, 2].map((i) => (
            <span key={i} className="fx-sring" style={{ '--i': i } as React.CSSProperties} />
          ))}
          <span className="fx-core" />
        </>
      )}
      {b.kind === 'xyz' && (
        <>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="fx-mist" style={{ '--i': i } as React.CSSProperties} />
          ))}
          <span className="fx-blast" />
          <span className="fx-rays" />
        </>
      )}
      {b.kind === 'ritual' && (
        <>
          <span className="fx-rcircle">
            <svg viewBox="-50 -50 100 100">
              <circle r="46" />
              <circle r="40" />
              <polygon points="0,-40 34.6,20 -34.6,20" />
              <polygon points="0,40 34.6,-20 -34.6,-20" />
              <circle r="18" />
            </svg>
          </span>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="fx-flame" style={{ '--i': i } as React.CSSProperties} />
          ))}
          <span className="fx-core" />
        </>
      )}
      {b.kind === 'link' && (
        <>
          <span className="fx-circuit" />
          {(b.arrows ?? []).map((m, i) => {
            const d = m.length === 2 ? corner + 6 : m === 'L' || m === 'R' ? cw / 2 + 10 : ch / 2 + 10;
            return (
              <span
                key={m}
                className="fx-arrow"
                style={
                  {
                    '--a': `${ARROW_ANGLE[m] + (b.mirror ? 180 : 0)}deg`,
                    '--d': `${d}px`,
                    '--i': i,
                  } as React.CSSProperties
                }
              />
            );
          })}
        </>
      )}
      {b.label && <span className="fx-label">{b.label}</span>}
    </div>
  );
}
