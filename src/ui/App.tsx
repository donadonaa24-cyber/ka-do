import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CARD_DB, CARD_SCRIPTS, DECKS } from '../data';
import {
  type Action,
  applyAction,
  createGame,
  type Ctx,
  findLocation,
  getDef,
  isMonsterZone,
  isOnField,
  makeEnv,
  type MonsterLocation,
  type SummonMethod,
  ZONE_LABEL,
} from '../engine/game';
import { randomSeed } from '../engine/rng';
import { tributesRequired } from '../engine/rules';
import type { BattlePosition, GameState, Location, PileZone } from '../engine/types';
import { isExtraDeckCard, PHASE_LABEL } from '../engine/types';
import { Board } from './Board';
import { CardView, statLine } from './CardView';
import { loadCurrent, loadRoutes, type SavedRoute, saveCurrent, saveRoutes, type SessionData } from './session';
import { SetupDialog } from './SetupDialog';
import { RoutePanel } from './RoutePanel';
import { useDrag } from './useDrag';
import { TOON_GUIDES } from '../data/toonGuides';
import { type Guide, stepMatches } from '../engine/guide';
import {
  afterPick,
  completeStep,
  currentStep,
  effectAvailable,
  pickRange,
  type RunResult,
  type Running,
  runZoneKind,
  startEffect,
  stepCandidates,
} from '../engine/effectRunner';
import { matchesFilter } from '../engine/filters';
import type { EffectDef } from '../engine/scripts';

type PickSource = 'field' | 'hand' | 'gy';

/** 素材やゾーンの選択を伴う操作 */
interface Pending {
  title: string;
  hint: string;
  pickFrom?: PickSource[];
  single?: boolean;
  picked: string[];
  stage: 'pick' | 'zone';
  zone: 'monster' | 'stz' | 'none';
  /** EXモンスターゾーンを選べる（EXデッキからの特殊召喚） */
  allowEmz?: boolean;
  /** ドラッグで先に決まっている出し先 */
  presetZone?: Location;
  build: (picked: string[], zone: Location | null) => Action;
}

/** ドラッグで落とせる先（ボタンの操作でカードが行く場所） */
type DropDest = 'monster' | 'stz' | 'fz' | 'hand' | 'gy' | 'banished' | 'deck';

interface Btn {
  label: string;
  onClick: () => void;
  primary?: boolean;
  dest?: DropDest;
}

const defaultSession = (): SessionData => ({
  deckName: DECKS[0].name,
  seed: randomSeed(),
  fixedHand: [],
  strict: true,
  actions: [],
});

/** 記録済みの操作は検証済みなので、再生時はルールチェックなしで適用する */
const replayCtx: Ctx = { db: CARD_DB, options: { strict: false }, scripts: CARD_SCRIPTS };

export function App() {
  const [session, setSession] = useState<SessionData>(() => loadCurrent() ?? defaultSession());
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [run, setRun] = useState<Running | null>(null);
  const [pile, setPile] = useState<PileZone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [routes, setRoutes] = useState<SavedRoute[]>(() => loadRoutes());
  const [routeName, setRouteName] = useState('');
  const [guideId, setGuideId] = useState<string | null>(null);
  const [dropMenu, setDropMenu] = useState<{ x: number; y: number; title: string; options: Btn[] } | null>(null);
  /** ドラッグで決まった出し先。次に始める操作で1回だけ使う */
  const presetRef = useRef<Location | null>(null);

  const ctx: Ctx = useMemo(
    () => ({ db: CARD_DB, options: { strict: session.strict }, scripts: CARD_SCRIPTS }),
    [session.strict],
  );
  const deck = DECKS.find((d) => d.name === session.deckName) ?? DECKS[0];

  const { state, appliedCount } = useMemo(() => {
    let s: GameState = createGame(deck, replayCtx, session.seed, session.fixedHand);
    let n = 0;
    for (const a of session.actions) {
      const r = applyAction(s, a, replayCtx);
      if (!r.ok) break;
      s = r.state;
      n++;
    }
    return { state: s, appliedCount: n };
  }, [deck, session.seed, session.fixedHand, session.actions]);

  useEffect(() => saveCurrent(session), [session]);
  useEffect(() => {
    if (appliedCount < session.actions.length) {
      setError(`記録の${appliedCount + 1}手目以降を再現できなかったため破棄しました`);
      setSession((s) => ({ ...s, actions: s.actions.slice(0, appliedCount) }));
    }
  }, [appliedCount, session.actions.length]);

  // 続けて dispatch しても最新の盤面に適用されるよう、盤面は ref でも持つ
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatch = useCallback(
    (action: Action): boolean => {
      const r = applyAction(stateRef.current, action, ctx);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      stateRef.current = r.state;
      setError(null);
      setSession((s) => ({ ...s, actions: [...s.actions, action] }));
      return true;
    },
    [ctx],
  );

  const undo = useCallback(() => {
    setPending(null);
    setRun(null);
    setError(null);
    setSession((s) => ({ ...s, actions: s.actions.slice(0, -1) }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === 'Escape') {
        setPending(null);
        setRun(null);
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  // 選択中のカードが消えた（トークン消滅・アンドゥ）場合は選択を外す
  const sel = selected && state.cards[selected] ? selected : null;
  const def = (uid: string) => getDef(state, ctx, uid);

  // ===== 素材・ゾーン選択 =====

  const start = (p: Omit<Pending, 'picked' | 'stage'>) => {
    setError(null);
    const presetZone = presetRef.current ?? undefined;
    presetRef.current = null;
    if (p.pickFrom) setPending({ ...p, presetZone, picked: [], stage: 'pick' });
    else if (p.zone !== 'none' && presetZone) dispatch(p.build([], presetZone));
    else if (p.zone !== 'none') setPending({ ...p, picked: [], stage: 'zone' });
    else dispatch(p.build([], null));
  };

  const confirmPick = (p: Pending, picked = p.picked) => {
    if (p.zone === 'none' || p.presetZone) {
      if (dispatch(p.build(picked, p.presetZone ?? null))) setPending(null);
    } else {
      setPending({ ...p, picked, stage: 'zone' });
    }
  };

  const canPick = (p: Pending, uid: string) => {
    const loc = findLocation(state, uid);
    return (
      (p.pickFrom!.includes('field') && isMonsterZone(loc)) ||
      (p.pickFrom!.includes('hand') && loc?.zone === 'hand') ||
      (p.pickFrom!.includes('gy') && loc?.zone === 'gy')
    );
  };

  const onRunResult = (r: RunResult) => {
    if (r.kind === 'error') {
      setError(r.error);
      setRun(null);
    } else if (r.kind === 'running') {
      setRun(r.run);
    } else {
      setRun(null);
      dispatch(r.action);
    }
  };

  const runEffect = (uid: string, effect: EffectDef) => {
    setError(null);
    setPending(null);
    const preset = presetRef.current;
    presetRef.current = null;
    let r = startEffect(state, ctx, uid, effect, preset ?? undefined);
    // ドラッグで出し先が決まっていれば最初のゾーン選択に使う
    if (preset && r.kind === 'running' && r.run.stage === 'zone') r = completeStep(r.run, ctx, preset);
    onRunResult(r);
  };

  const toggleRunPick = (uid: string) => {
    if (!run || run.stage !== 'pick' || !stepCandidates(run, ctx).includes(uid)) return;
    const [, max] = pickRange(run, ctx);
    if (max === 1) {
      onRunResult(afterPick({ ...run, picked: [uid] }, ctx));
      return;
    }
    const picked = run.picked.includes(uid) ? run.picked.filter((u) => u !== uid) : [...run.picked, uid];
    if (picked.length <= max) setRun({ ...run, picked });
  };

  const onCardClick = (uid: string) => {
    if (run) return toggleRunPick(uid);
    if (pending?.stage === 'pick') {
      if (!canPick(pending, uid)) return;
      if (pending.single) return confirmPick(pending, [uid]);
      const picked = pending.picked.includes(uid)
        ? pending.picked.filter((u) => u !== uid)
        : [...pending.picked, uid];
      setPending({ ...pending, picked });
      return;
    }
    setSelected(uid);
  };

  const zoneSelectable = (loc: Location) => {
    if (run) {
      const kind = runZoneKind(run);
      if (loc.zone === 'emz' && findLocation(run.temp, run.picked[0] ?? '')?.zone !== 'extra') return false;
      if (kind === 'monster' && (loc.zone === 'mz' || loc.zone === 'emz')) return !run.temp[loc.zone][loc.index];
      if (kind === 'stz' && loc.zone === 'stz') return !run.temp.stz[loc.index];
      return false;
    }
    if (pending?.stage !== 'zone') return false;
    if (loc.zone === 'emz' && !pending.allowEmz) return false;
    if (pending.zone === 'monster' && (loc.zone === 'mz' || loc.zone === 'emz')) {
      const occ = state[loc.zone][loc.index];
      return !occ || pending.picked.includes(occ);
    }
    if (pending.zone === 'stz' && loc.zone === 'stz') return !state.stz[loc.index];
    return false;
  };

  const onZoneClick = (loc: Location) => {
    if (run) return onRunResult(completeStep(run, ctx, loc));
    if (!pending) return;
    if (dispatch(pending.build(pending.picked, loc))) setPending(null);
  };

  // ===== 選択中カードの操作ボタン =====

  const move = (uid: string, to: Location, reason?: string, toBottom?: boolean): Action => ({
    type: 'MOVE',
    uid,
    to,
    reason,
    toBottom,
  });

  const summonButtons = (uid: string): Btn[] => {
    const ss = (position: BattlePosition, faceDown = false): Btn => ({
      label: faceDown ? '特殊召喚（裏守備）' : `特殊召喚（${position === 'atk' ? '攻撃' : '守備'}）`,
      dest: 'monster',
      onClick: () =>
        start({
          title: `${def(uid).name}を特殊召喚`,
          hint: '出すゾーンを選択',
          zone: 'monster',
          allowEmz: findLocation(state, uid)?.zone === 'extra',
          build: (_, z) => ({ type: 'SPECIAL_SUMMON', uid, to: z as MonsterLocation, position, faceDown }),
        }),
    });
    return [ss('atk'), ss('def'), ss('def', true)];
  };

  const procedure = (uid: string, method: SummonMethod, label: string): Btn => ({
    label: `${label}召喚`,
    primary: true,
    dest: 'monster',
    onClick: () =>
      start({
        title: `${def(uid).name}を${label}召喚`,
        hint: `${def(uid).materialText ?? ''} 素材を選んで「決定」→ 出すゾーンを選択`,
        pickFrom: method === 'fusion' || method === 'ritual' ? ['hand', 'field'] : ['field'],
        zone: 'monster',
        allowEmz: method !== 'ritual',
        build: (picked, z) => ({ type: 'PROCEDURE_SUMMON', method, uid, materials: picked, to: z as MonsterLocation }),
      }),
  });

  const effectBtn = (uid: string): Btn => ({
    label: '効果発動（記録）',
    onClick: () => dispatch({ type: 'ACTIVATE_EFFECT', uid }),
  });

  const commonMoves = (uid: string, loc: Location): Btn[] => {
    const btns: Btn[] = [];
    if (loc.zone !== 'hand') btns.push({ label: '手札へ', dest: 'hand', onClick: () => dispatch(move(uid, { zone: 'hand' })) });
    if (loc.zone !== 'gy') btns.push({ label: '墓地へ', dest: 'gy', onClick: () => dispatch(move(uid, { zone: 'gy' })) });
    if (loc.zone !== 'banished') btns.push({ label: '除外', dest: 'banished', onClick: () => dispatch(move(uid, { zone: 'banished' })) });
    if (loc.zone === 'banished' || loc.zone === 'gy' || loc.zone === 'hand') {
      btns.push({
        label: '裏側で除外',
        dest: 'banished',
        onClick: () => dispatch({ type: 'MOVE', uid, to: { zone: 'banished' }, faceUp: false }),
      });
    }
    btns.push({ label: 'デッキの上へ', dest: 'deck', onClick: () => dispatch(move(uid, { zone: 'deck' })) });
    btns.push({ label: 'デッキの下へ', dest: 'deck', onClick: () => dispatch(move(uid, { zone: 'deck' }, undefined, true)) });
    return btns;
  };

  const buttonsFor = (uid: string): Btn[] => {
    const d = def(uid);
    const inst = state.cards[uid];
    const loc = findLocation(state, uid);
    if (!loc) return [];
    const btns: Btn[] = [];
    const script = CARD_SCRIPTS[d.id];
    const scriptedActivation = !!script?.effects?.some((e) => e.isCardActivation);
    for (const e of script?.effects ?? []) {
      if (!effectAvailable(state, uid, e)) continue;
      // 手札から発動する魔法・罠、自身を出す効果はドラッグでも使える
      const dest: DropDest | undefined =
        e.isCardActivation && loc.zone === 'hand'
          ? d.spellType === 'field'
            ? 'fz'
            : 'stz'
          : e.steps[0]?.op === 'place'
            ? 'monster'
            : undefined;
      btns.push({ label: e.label, primary: true, dest, onClick: () => runEffect(uid, e) });
    }
    (script?.procedures ?? []).forEach((proc, i) => {
      if (!(proc.summonFrom as string[]).includes(loc.zone)) return;
      const pickFrom: PickSource[] = proc.from.map((f) => (f === 'monsters' ? 'field' : f === 'gy' ? 'gy' : 'hand'));
      btns.push({
        label: `特殊召喚：${proc.label}`,
        primary: true,
        dest: 'monster',
        onClick: () =>
          start({
            title: `${d.name}を特殊召喚（${proc.label}）`,
            hint: `${proc.hint}（墓地のカードは墓地を開いて選択）→「決定」→ ゾーンを選択`,
            pickFrom: pickFrom.length ? pickFrom : undefined,
            zone: 'monster',
            allowEmz: loc.zone === 'extra',
            build: (picked, z) => ({ type: 'PROC_SUMMON', uid, proc: i, materials: picked, to: z as MonsterLocation }),
          }),
      });
    });

    if (loc.zone === 'hand' && d.kind === 'monster') {
      const env = makeEnv(state, ctx, uid);
      state.summonGrants.forEach((g, gi) => {
        if (!matchesFilter(d, g.filter, env.toonWorld)) return;
        if (g.extraSummon) {
          const need = tributesRequired(d.level ?? 0);
          btns.push({
            label: `追加召喚（${g.source}）`,
            primary: true,
            dest: 'monster',
            onClick: () =>
              start({
                title: `${d.name}を${g.source}の効果で召喚`,
                hint: need ? `リリースするモンスターを${need}体選んで「決定」→ ゾーンを選択` : 'ゾーンを選択',
                pickFrom: need ? ['field'] : undefined,
                zone: 'monster',
                build: (picked, z) => ({ type: 'NORMAL_SUMMON', uid, index: (z as MonsterLocation).index, tributes: picked, grant: gi }),
              }),
          });
        }
        if (g.noTribute && (d.level ?? 0) >= 5) {
          btns.push({
            label: `リリースなしで召喚（${g.source}）`,
            primary: true,
            dest: 'monster',
            onClick: () =>
              start({
                title: `${d.name}をリリースなしで召喚`,
                hint: 'ゾーンを選択',
                zone: 'monster',
                build: (_, z) => ({ type: 'NORMAL_SUMMON', uid, index: (z as MonsterLocation).index, noTributeGrant: gi }),
              }),
          });
        }
      });
      if (!isExtraDeckCard(d) && !d.cannotNormalSummon) {
        const need = tributesRequired(d.level ?? 0);
        const ns = (set: boolean): Btn => ({
          label: set ? 'セット' : need ? `アドバンス召喚（リリース${need}）` : '通常召喚',
          primary: !set,
          dest: 'monster',
          onClick: () =>
            start({
              title: `${d.name}を${set ? 'セット' : '召喚'}`,
              hint: need ? `リリースするモンスターを${need}体選んで「決定」→ ゾーンを選択` : 'ゾーンを選択',
              pickFrom: need ? ['field'] : undefined,
              zone: 'monster',
              build: (picked, z) => ({
                type: 'NORMAL_SUMMON',
                uid,
                index: (z as MonsterLocation).index,
                tributes: picked,
                set,
              }),
            }),
        });
        btns.push(ns(false), ns(true));
      }
      if (d.frame === 'ritual') btns.push(procedure(uid, 'ritual', '儀式'));
      btns.push(...summonButtons(uid), effectBtn(uid));
    } else if (loc.zone === 'hand') {
      const toZone = d.spellType === 'field' ? 'none' : 'stz';
      const dest: DropDest = d.spellType === 'field' ? 'fz' : 'stz';
      if (d.kind === 'spell' && !scriptedActivation) {
        btns.push({
          label: '発動',
          primary: true,
          dest,
          onClick: () =>
            start({
              title: `${d.name}を発動`,
              hint: '置くゾーンを選択',
              zone: toZone,
              build: (_, z) => ({ type: 'ACTIVATE_CARD', uid, index: z && 'index' in z ? z.index : undefined }),
            }),
        });
      }
      btns.push({
        label: 'セット',
        dest,
        onClick: () =>
          start({
            title: `${d.name}をセット`,
            hint: 'セットするゾーンを選択',
            zone: toZone,
            build: (_, z) => ({ type: 'SET_SPELL_TRAP', uid, index: z && 'index' in z ? z.index : undefined }),
          }),
      });
    } else if (isMonsterZone(loc)) {
      btns.push(effectBtn(uid));
      if (inst.faceUp) {
        btns.push({ label: '表示形式変更', onClick: () => dispatch({ type: 'CHANGE_POSITION', uid }) });
        if (state.phase === 'BP') btns.push({ label: '直接攻撃', primary: true, onClick: () => dispatch({ type: 'ATTACK', uid }) });
      } else {
        btns.push({ label: '反転召喚', onClick: () => dispatch({ type: 'FLIP_SUMMON', uid }) });
        btns.push({
          label: '表にする（効果で）',
          onClick: () => dispatch({ type: 'MOVE', uid, to: loc, faceUp: true, position: inst.position, reason: '表側にする' }),
        });
      }
      btns.push({ label: 'リリース', onClick: () => dispatch(move(uid, { zone: 'gy' }, 'リリース')) });
      btns.push({
        label: 'ゾーン移動',
        dest: 'monster',
        onClick: () =>
          start({
            title: `${d.name}を移動`,
            hint: '移動先のゾーンを選択',
            zone: 'monster',
            allowEmz: true,
            build: (_, z) => ({ type: 'MOVE', uid, to: z!, faceUp: inst.faceUp, position: inst.position }),
          }),
      });
      if (d.frame !== 'token') {
        btns.push({
          label: 'X素材にする',
          onClick: () =>
            start({
              title: `${d.name}をエクシーズ素材にする`,
              hint: '重ねる先のエクシーズモンスターを選択',
              pickFrom: ['field'],
              single: true,
              zone: 'none',
              build: (picked) => ({ type: 'ATTACH', uid, target: picked[0] }),
            }),
        });
      }
    } else if (loc.zone === 'stz' || loc.zone === 'fz') {
      if (inst.pendingResolve) btns.push({ label: '解決（墓地へ）', primary: true, onClick: () => dispatch({ type: 'RESOLVE', uid }) });
      if (!inst.faceUp && !scriptedActivation) btns.push({ label: '発動', primary: true, onClick: () => dispatch({ type: 'ACTIVATE_CARD', uid }) });
      else if (inst.faceUp) btns.push(effectBtn(uid));
    } else if (loc.zone === 'extra') {
      const methods: Partial<Record<string, [SummonMethod, string]>> = {
        fusion: ['fusion', '融合'],
        synchro: ['synchro', 'シンクロ'],
        xyz: ['xyz', 'エクシーズ'],
        link: ['link', 'リンク'],
      };
      const m = d.frame && methods[d.frame];
      if (m) btns.push(procedure(uid, m[0], m[1]));
      btns.push(...summonButtons(uid));
    } else {
      // デッキ・墓地・除外
      if (loc.zone === 'deck') btns.push({ label: '手札に加える', primary: true, onClick: () => dispatch(move(uid, { zone: 'hand' }, 'サーチ')) });
      if (d.kind === 'monster') btns.push(...summonButtons(uid));
      else {
        btns.push({
          label: '魔法＆罠ゾーンに置く',
          dest: d.spellType === 'field' ? 'fz' : 'stz',
          onClick: () =>
            start({
              title: `${d.name}を置く`,
              hint: 'ゾーンを選択',
              zone: d.spellType === 'field' ? 'none' : 'stz',
              build: (_, z) => move(uid, z ?? { zone: 'fz' }),
            }),
        });
      }
      if (loc.zone !== 'deck') btns.push(effectBtn(uid));
    }

    btns.push(...commonMoves(uid, loc));
    return btns;
  };

  // ===== ドラッグ＆ドロップ =====

  const onDrop = (uid: string, target: string, x: number, y: number) => {
    if (run || pending || !state.cards[uid]) return;
    const [zone, idx] = target.split(':');
    const loc: Location | null =
      zone === 'mz' || zone === 'emz' || zone === 'stz' ? ({ zone, index: Number(idx) } as Location) : zone === 'fz' ? { zone: 'fz' } : null;
    const destOf: Record<string, DropDest> = { mz: 'monster', emz: 'monster', stz: 'stz', fz: 'fz', hand: 'hand', gy: 'gy', banished: 'banished', deck: 'deck' };
    const dest = destOf[zone];
    const from = findLocation(state, uid);
    if (!dest || (from && loc && JSON.stringify(from) === JSON.stringify(loc))) return;
    if (from?.zone === zone && !loc) return;
    const options = buttonsFor(uid)
      .filter((b) => b.dest === dest)
      .map((b) => ({
        ...b,
        onClick: () => {
          presetRef.current = loc;
          b.onClick();
          presetRef.current = null;
        },
      }));
    if (options.length === 0) setError(`${def(uid).name}はそこに置けません`);
    else if (options.length === 1) options[0].onClick();
    else setDropMenu({ x, y, title: def(uid).name, options });
  };

  const { drag, dragStart, onClickCapture } = useDrag(onDrop);

  // ===== ルートガイド =====

  const guide = TOON_GUIDES.find((g) => g.id === guideId) ?? null;
  /** ログを先頭から見て、ガイドの手順が何手目まで終わっているか */
  const guideDone = useMemo(() => {
    if (!guide) return 0;
    let pos = 0;
    let done = 0;
    for (const step of guide.steps) {
      let found = -1;
      for (let j = pos; j < state.log.length; j++) {
        const text = state.log.slice(pos, j + 1).map((l) => l.text).join('\n');
        if (stepMatches(step, text)) {
          found = j;
          break;
        }
      }
      if (found < 0) break;
      pos = found + 1;
      done++;
    }
    return done;
  }, [guide, state.log]);

  const startGuide = (g: Guide) => {
    setSession({ deckName: g.deckName, seed: g.seed, fixedHand: g.fixedHand, strict: true, actions: [] });
    setGuideId(g.id);
    setSelected(null);
    setPending(null);
    setRun(null);
  };

  // ===== 表示 =====

  const selDef = sel ? def(sel) : null;
  const selLoc = sel ? findLocation(state, sel) : null;
  // 効果処理中は途中経過の盤面を表示する
  const view = run?.temp ?? state;
  const vdef = (uid: string) => getDef(view, ctx, uid);
  const pileCards = pile ? view[pile] : [];
  const runStep = run && currentStep(run);
  const runCands = run ? stepCandidates(run, ctx) : [];
  const [runMin, runMax] = run ? pickRange(run, ctx) : [0, 0];

  const saveRoute = () => {
    const name = routeName.trim() || `${deck.name} シード${session.seed}`;
    setRouteName('');
    const next = [...routes, { ...session, name, savedAt: new Date().toISOString() }];
    setRoutes(next);
    saveRoutes(next);
  };

  const copyLog = () => {
    const text = state.log.map((l) => `[T${l.turn} ${PHASE_LABEL[l.phase]}] ${l.text}`).join('\n');
    try {
      navigator.clipboard?.writeText(text).catch(() => setError('コピーできませんでした。ログを長押しして選択してください'));
    } catch {
      setError('コピーできませんでした。ログを長押しして選択してください');
    }
  };

  const pendingButtons = pending && (
    <div className="pending">
      <strong>{pending.title}</strong>
      <span>{pending.stage === 'pick' ? pending.hint : '出す（置く）ゾーンを選択してください'}</span>
      {pending.stage === 'pick' && (
        <span className="picked">
          選択中: {pending.picked.map((u) => def(u).name).join('、') || 'なし'}
        </span>
      )}
      <div className="btn-row">
        {pending.stage === 'pick' && !pending.single && (
          <button className="primary" onClick={() => confirmPick(pending)}>
            決定
          </button>
        )}
        <button onClick={() => setPending(null)}>キャンセル</button>
      </div>
    </div>
  );

  const runPanel = run && (
    <div className="pending run">
      <strong>{run.title}</strong>
      <span>
        {run.stage === 'zone'
          ? runStep?.op === 'place'
            ? runStep.prompt
            : '出す（置く）ゾーンを選択してください'
          : run.stage === 'mode'
            ? '処理を選択してください'
            : runStep?.op === 'pick'
              ? `${runStep.prompt}（${runMin === runMax ? runMin : `${runMin}〜${runMax}`}枚）`
              : ''}
      </span>
      {run.stage === 'pick' && (
        <div className="run-cands">
          {runCands.map((u) => (
            <CardView
              key={u}
              def={vdef(u)}
              small
              highlighted={run.picked.includes(u)}
              onClick={() => toggleRunPick(u)}
            />
          ))}
        </div>
      )}
      <div className="btn-row">
        {run.stage === 'pick' && runMax > 1 && (
          <button
            className="primary"
            disabled={run.picked.length < runMin}
            onClick={() => onRunResult(afterPick(run, ctx))}
          >
            決定（{run.picked.length}枚）
          </button>
        )}
        {run.stage === 'pick' && runMin === 0 && (
          <button onClick={() => onRunResult(afterPick({ ...run, picked: [] }, ctx))}>選ばない</button>
        )}
        {run.stage === 'mode' &&
          runStep?.op === 'pick' &&
          runStep.modes?.map((m, i) => (
            <button key={m} className="primary" onClick={() => onRunResult(afterPick({ ...run, mode: i, stage: 'mode' }, ctx))}>
              {m}
            </button>
          ))}
        <button onClick={() => setRun(null)}>キャンセル</button>
      </div>
    </div>
  );

  return (
    <div className={`app ${run || pending ? 'busy' : ''} ${drag ? 'dragging' : ''}`} onClickCapture={onClickCapture}>
      <header className="topbar">
        <h1>遊戯王 一人回し</h1>
        <div className="status">
          <span>ターン{state.turn}</span>
          <span className="phase">{PHASE_LABEL[state.phase]}</span>
          <span>LP {state.lp}</span>
          <span>相手LP {state.opponentLp}</span>
          <span className={state.normalSummonUsed ? 'used' : 'avail'}>
            通常召喚{state.normalSummonUsed ? '済' : '可'}
          </span>
          {!session.strict && <span className="free">フリー操作</span>}
          {state.status !== 'playing' && (
            <span className="result">{state.status === 'won' ? '勝利' : '敗北'}：{state.statusReason}</span>
          )}
        </div>
        <div className="btn-row">
          <button className="primary" onClick={() => dispatch({ type: 'NEXT_PHASE' })}>
            次のフェイズ
          </button>
          <button onClick={() => dispatch({ type: 'END_TURN' })}>ターン終了</button>
          <button onClick={() => dispatch({ type: 'DRAW' })}>ドロー</button>
          <button onClick={() => dispatch({ type: 'SHUFFLE_DECK' })}>シャッフル</button>
          <button onClick={() => setShowToken((v) => !v)}>トークン</button>
          <button onClick={undo} disabled={session.actions.length === 0}>
            戻す (Ctrl+Z)
          </button>
          <button
            onClick={() => setSession((s) => ({ ...s, actions: [] }))}
            disabled={session.actions.length === 0}
          >
            最初から
          </button>
          <button onClick={() => setShowSetup(true)}>新しいゲーム</button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={session.strict}
              onChange={(e) => setSession((s) => ({ ...s, strict: e.target.checked }))}
            />
            ルールチェック
          </label>
        </div>
        {error && (
          <div className="error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {pendingButtons}
        {runPanel}
        {showToken && (
          <TokenForm
            onCreate={(t) =>
              start({
                title: `${t.name}を生成`,
                hint: '',
                zone: 'monster',
                build: (_, z) => ({ type: 'CREATE_TOKEN', ...t, to: z as MonsterLocation }),
              })
            }
          />
        )}
      </header>

      <main className="main">
        <section className="play">
          <Board
            state={view}
            ctx={ctx}
            selected={sel}
            picked={pending?.picked ?? []}
            zoneSelectable={zoneSelectable}
            onCardClick={onCardClick}
            onZoneClick={onZoneClick}
            onPileClick={(z) => setPile(pile === z ? null : z)}
            dragStart={run || pending ? undefined : dragStart}
            dropTarget={drag?.target}
          />
          {pile && (
            <div className="pile-view">
              <div className="pile-head">
                <strong>
                  {ZONE_LABEL[pile]}（{pileCards.length}枚）
                </strong>
                {pile === 'deck' && <small>左がデッキトップ</small>}
                <button onClick={() => setPile(null)}>閉じる</button>
              </div>
              <div className="pile-cards">
                {(pile === 'gy' || pile === 'banished' ? [...pileCards].reverse() : pileCards).map((u) => (
                  <CardView
                    key={u}
                    def={vdef(u)}
                    inst={pile === 'banished' ? view.cards[u] : undefined}
                    selected={sel === u}
                    highlighted={pending?.picked.includes(u) || run?.picked.includes(u)}
                    onClick={() => onCardClick(u)}
                    onPointerDown={run || pending ? undefined : dragStart(u)}
                    small
                  />
                ))}
              </div>
            </div>
          )}
          <div className={`hand ${drag?.target === 'hand' ? 'drop-over' : ''}`} data-drop="hand">
            <div className="hand-label">手札 {view.hand.length}枚</div>
            <div className="hand-cards">
              {view.hand.map((u) => (
                <CardView
                  key={u}
                  def={vdef(u)}
                  selected={sel === u}
                  highlighted={pending?.picked.includes(u) || run?.picked.includes(u)}
                  onClick={() => onCardClick(u)}
                  onPointerDown={run || pending ? undefined : dragStart(u)}
                />
              ))}
            </div>
          </div>
        </section>

        <aside className="side">
          <section className={`detail ${sel ? 'has-sel' : ''}`}>
            {sel && selDef && selLoc ? (
              <>
                <div className="detail-head">
                  <h2>{selDef.name}</h2>
                  <button className="sheet-close" onClick={() => setSelected(null)} aria-label="閉じる">
                    閉じる
                  </button>
                </div>
                <div className="meta">
                  {selDef.attribute && `${selDef.attribute}属性 `}
                  {selDef.race && `${selDef.race} `}
                  {statLine(selDef)}
                  {selDef.tuner && ' / チューナー'}
                  {' ・ '}
                  {ZONE_LABEL[selLoc.zone]}
                  {isOnField(selLoc) && !state.cards[sel].faceUp && '（裏側）'}
                </div>
                {selDef.materialText && <div className="meta">素材: {selDef.materialText}</div>}
                <p className="text">{selDef.text}</p>
                {state.cards[sel].overlay.length > 0 && (
                  <div className="overlay-list">
                    エクシーズ素材:
                    {state.cards[sel].overlay.map((m) => (
                      <button key={m} onClick={() => dispatch({ type: 'DETACH', target: sel, uid: m })}>
                        {def(m).name} を取り除く
                      </button>
                    ))}
                  </div>
                )}
                <div className="btn-grid">
                  {(run ? [] : buttonsFor(sel)).map((b) => (
                    <button
                      key={b.label}
                      className={[b.primary ? 'primary' : '', b.label.length > 10 ? 'wide' : ''].join(' ')}
                      onClick={b.onClick}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="note">カードをクリックすると操作が表示されます。デッキ・墓地・除外・EXはクリックで中身を表示。</p>
            )}
          </section>

          <RoutePanel
            state={state}
            ctx={ctx}
            actionCount={session.actions.length}
            guides={TOON_GUIDES}
            guideProgress={guide ? { id: guide.id, done: guideDone } : null}
            dispatch={dispatch}
            onStartGuide={startGuide}
            onError={setError}
          />

          <section className="log">
            <div className="log-head">
              <strong>ルート記録（{session.actions.length}手）</strong>
              <button onClick={copyLog}>コピー</button>
            </div>
            <div className="route-save">
              <input
                id="route-name"
                value={routeName}
                placeholder={`ルート名（例：${deck.name} シード${session.seed}）`}
                onChange={(e) => setRouteName(e.target.value)}
              />
              <button onClick={saveRoute}>保存</button>
            </div>
            <ol className="log-list">
              {state.log.map((l, i) => (
                <li key={i} className={`log-${l.kind}`}>
                  <span className="log-turn">T{l.turn}</span>
                  {l.text}
                </li>
              ))}
            </ol>
            {routes.length > 0 && (
              <div className="routes">
                <strong>保存したルート</strong>
                {routes.map((r, i) => (
                  <div key={i} className="route-row">
                    <span className="grow">{r.name}</span>
                    <button
                      onClick={() => {
                        setSession({ deckName: r.deckName, seed: r.seed, fixedHand: r.fixedHand, strict: r.strict, actions: r.actions });
                        setPending(null);
                        setSelected(null);
                      }}
                    >
                      読込
                    </button>
                    <button
                      onClick={() => {
                        const next = routes.filter((_, j) => j !== i);
                        setRoutes(next);
                        saveRoutes(next);
                      }}
                    >
                      削除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </main>

      {drag && state.cards[drag.uid] && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
          <CardView def={def(drag.uid)} small />
        </div>
      )}

      {dropMenu && (
        <div className="drop-menu-backdrop" onClick={() => setDropMenu(null)}>
          <div
            className="drop-menu"
            style={{
              left: Math.max(8, Math.min(dropMenu.x, window.innerWidth - 260)),
              top: Math.max(8, Math.min(dropMenu.y, window.innerHeight - 90 - dropMenu.options.length * 40)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong>{dropMenu.title}</strong>
            {dropMenu.options.map((o) => (
              <button
                key={o.label}
                className={o.primary ? 'primary' : ''}
                onClick={() => {
                  setDropMenu(null);
                  o.onClick();
                }}
              >
                {o.label}
              </button>
            ))}
            <button onClick={() => setDropMenu(null)}>キャンセル</button>
          </div>
        </div>
      )}

      {showSetup && (
        <SetupDialog
          initial={{ ...session, seed: randomSeed() }}
          onClose={() => setShowSetup(false)}
          onStart={(s) => {
            try {
              createGame(DECKS.find((d) => d.name === s.deckName) ?? DECKS[0], replayCtx, s.seed, s.fixedHand);
            } catch (e) {
              setError((e as Error).message);
              return;
            }
            setSession(s);
            setGuideId(null);
            setSelected(null);
            setPending(null);
            setPile(null);
            setShowSetup(false);
          }}
        />
      )}
    </div>
  );
}

interface TokenSpec {
  name: string;
  level: number;
  atk: number;
  def: number;
}

function TokenForm({ onCreate }: { onCreate: (t: TokenSpec) => void }) {
  const [t, setT] = useState<TokenSpec>({ name: 'トークン', level: 1, atk: 0, def: 0 });
  const num = (k: keyof TokenSpec) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setT({ ...t, [k]: Number(e.target.value) || 0 });
  return (
    <div className="token-form">
      <input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
      <label>
        Lv
        <input type="number" value={t.level} onChange={num('level')} />
      </label>
      <label>
        ATK
        <input type="number" value={t.atk} onChange={num('atk')} />
      </label>
      <label>
        DEF
        <input type="number" value={t.def} onChange={num('def')} />
      </label>
      <button className="primary" onClick={() => onCreate(t)}>
        ゾーンを選んで生成
      </button>
    </div>
  );
}
