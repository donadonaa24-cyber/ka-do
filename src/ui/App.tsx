import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUILTIN_DECKS, CARD_DB, CARD_SCRIPTS } from '../data';
import { DeckEditor } from './DeckEditor';
import { loadDecks, type SavedDeck, saveDecks } from './deckStore';
import {
  type Action,
  applyAction,
  canAttackDirectly,
  canAttackInDefense,
  createGame,
  type Ctx,
  findLocation,
  getDef,
  isMonsterZone,
  isOnField,
  makeEnv,
  type MonsterLocation,
  oppMonsterSlots,
  type SummonMethod,
  ZONE_LABEL,
} from '../engine/game';
import { randomSeed } from '../engine/rng';
import { tributesRequired } from '../engine/rules';
import type { BattlePosition, GameState, Location, OppPile, PileZone } from '../engine/types';
import { BATTLE_STEP_LABEL, isExtraDeckCard, PHASE_LABEL } from '../engine/types';
import { Board } from './Board';
import { CardText, CardView, statLine } from './CardView';
import { loadCurrent, loadRoutes, type SavedRoute, saveCurrent, saveRoutes, type SessionData } from './session';
import { SetupDialog } from './SetupDialog';
import { HomeMenu } from './HomeMenu';
import { OppPlaceSheet } from './OppPlaceSheet';
import { OPP_PRESETS, oppPresetAction } from '../data/oppPresets';
import { oppWouldRespond } from '../engine/oppAI';
import { MotionLayer } from './Motion';
import { ImageSettings } from './ImageSettings';
import { RoutePanel, useRouteSearch } from './RoutePanel';
import { useDrag } from './useDrag';
import {
  BUILTIN_IMAGES,
  CardImageContext,
  type CardImages,
  fileToDataUrl,
  loadAllImages,
  removeImage,
  saveImage,
} from './cardImages';
import { GUIDES } from '../data/guides';
import { findGuideAction, type Guide } from '../engine/guide';
import {
  actionHighlights,
  type Coach,
  coachFromGuide,
  coachFromRoute,
  coachProgress,
  explainStep,
} from '../engine/coach';
import { StepPopup } from './StepPopup';
import {
  chainableEffects,
  fizzleTop,
  startResolve,
  afterPick,
  completeStep,
  currentStep,
  effectAvailable,
  effectUsedUp,
  effectSpeed,
  pickRange,
  type RunResult,
  type Running,
  zoneChoices,
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
  /** 俺ルール：ルール上は本来できない自由な操作（通常は隠す） */
  free?: boolean;
  /** このターンはもう使った効果（押せない） */
  used?: boolean;
}

const defaultSession = (): SessionData => ({
  deckName: BUILTIN_DECKS[0].name,
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
  const [pile, setPile] = useState<PileZone | OppPile | null>(null);
  /** 相手の盤面を手で置く練習モード */
  const [oppMode, setOppModeState] = useState(() => {
    try {
      return localStorage.getItem('ygo-opp-mode') === '1';
    } catch {
      return false;
    }
  });
  const setOppMode = (on: boolean) => {
    setOppModeState(on);
    try {
      localStorage.setItem('ygo-opp-mode', on ? '1' : '0');
    } catch {
      // 保存できなくても今の画面では使える
    }
  };
  /** カードを置こうとしている相手のゾーン */
  const [oppPlace, setOppPlace] = useState<Location | null>(null);
  /** 俺ルール：本来できない操作（自由に墓地へ送る・除外するなど）を常に出す */
  const [oreRule, setOreRuleState] = useState(() => {
    try {
      return localStorage.getItem('ygo-ore-rule') === '1';
    } catch {
      return false;
    }
  });
  const setOreRule = (on: boolean) => {
    setOreRuleState(on);
    try {
      localStorage.setItem('ygo-ore-rule', on ? '1' : '0');
    } catch {
      // 保存できなくても今の画面では使える
    }
  };
  /** カード詳細で俺ルールの操作を開いている */
  const [freeOpen, setFreeOpen] = useState(false);
  /** カードを選ぶ途中で、選択画面をたたんで盤面を確認している */
  const [peek, setPeek] = useState(false);
  // 選択が終わったり次の選択に進んだら、選択画面を開き直す
  useEffect(() => setPeek(false), [run?.stepIndex, run?.stage, !!run, pending?.stage, !!pending]);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  /** 起動時のメニュー画面（デッキ選択・始め方） */
  const [home, setHome] = useState(true);
  /** 「初手を選んで始める」で選んだデッキ */
  const [setupDeck, setSetupDeck] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [routes, setRoutes] = useState<SavedRoute[]>(() => loadRoutes());
  const [routeName, setRouteName] = useState('');
  const [coach, setCoach] = useState<Coach | null>(null);
  const [modal, setModal] = useState<'routes' | 'menu' | 'images' | 'decks' | null>(null);
  const [images, setImages] = useState<CardImages>(() => loadAllImages());
  /** 表示する画像：埋め込みの画像に、自分で設定した画像を上書き */
  const shownImages = useMemo(() => ({ ...BUILTIN_IMAGES, ...images }), [images]);
  /** チェーンを上から順に解決している */
  const [resolvingChain, setResolvingChain] = useState(false);
  /** ナビモード：自動で最適ルートを探し、1手ずつ解説する */
  const [navi, setNavi] = useState(false);
  /** 解説のポップアップ。普段は閉じて盤面で操作し、上の帯の「解説」で開く */
  const [popupOpen, setPopupOpen] = useState(false);
  /** 最後に自動で探した盤面（同じ盤面で何度も探さないため） */
  const naviKey = useRef('');
  const { w: winWidth, h: winHeight } = useWindowSize();
  /** 手札の帯の高さ（ナビの解説を手札の上に出すため） */
  const [handRef, handHeight] = useElementHeight<HTMLElement>();
  /** ナビの帯の高さ（盤面のカードの大きさを決めるのに使う） */
  const [coachRef, coachHeight] = useElementHeight<HTMLDivElement>();
  const routeSearch = useRouteSearch(useCallback((m: string) => setError(m), []));
  const [dropMenu, setDropMenu] = useState<{ x: number; y: number; title: string; options: Btn[] } | null>(null);
  /** ドラッグで決まった出し先。次に始める操作で1回だけ使う */
  const presetRef = useRef<Location | null>(null);

  const ctx: Ctx = useMemo(
    () => ({ db: CARD_DB, options: { strict: session.strict }, scripts: CARD_SCRIPTS }),
    [session.strict],
  );
  const [customDecks, setCustomDecks] = useState<SavedDeck[]>(() => loadDecks());
  const allDecks = useMemo(() => [...BUILTIN_DECKS, ...customDecks], [customDecks]);
  const deck = allDecks.find((d) => d.name === session.deckName) ?? BUILTIN_DECKS[0];

  const { state, appliedCount } = useMemo(() => {
    let s: GameState = createGame(deck, replayCtx, session.seed, session.fixedHand, session.handSize ?? 5);
    let n = 0;
    for (const a of session.actions) {
      const r = applyAction(s, a, replayCtx);
      if (!r.ok) break;
      s = r.state;
      n++;
    }
    return { state: s, appliedCount: n };
  }, [deck, session.seed, session.fixedHand, session.handSize, session.actions]);

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

  const onRunResult = (r: RunResult, prev?: Running) => {
    // 選び方が合わない時は、同じ効果の選択をやり直せるようにする
    if (r.kind === 'error' && prev) {
      setError(r.error);
      setRun({ ...prev, stage: 'pick', picked: [] });
      return;
    }
    if (r.kind === 'error') {
      setError(r.error);
      setRun(null);
      // 解決中のエラーで同じ解決を繰り返さないように止める
      setResolvingChain(false);
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
    // ルールチェック中は、チェーンできる効果があればチェーンに積んで止める
    let r = startEffect(state, ctx, uid, effect, preset ?? undefined, session.strict ? 'auto' : 'never');
    // ドラッグで出し先が決まっていれば最初のゾーン選択に使う
    if (preset && r.kind === 'running' && r.run.stage === 'zone') r = completeStep(r.run, ctx, preset);
    onRunResult(r);
  };

  const toggleRunPick = (uid: string) => {
    if (!run || run.stage !== 'pick' || !stepCandidates(run, ctx).includes(uid)) return;
    const [, max] = pickRange(run, ctx);
    if (max === 1) {
      onRunResult(afterPick({ ...run, picked: [uid] }, ctx), run);
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
      const picked = pending.picked.includes(uid) ? pending.picked.filter((u) => u !== uid) : [...pending.picked, uid];
      setPending({ ...pending, picked });
      return;
    }
    setSelected(uid);
  };

  const zoneSelectable = (loc: Location) => {
    if (run) {
      if (run.stage !== 'zone') return false;
      return zoneChoices(run).some(
        (z) => z.zone === loc.zone && 'index' in loc && 'index' in z && z.index === loc.index,
      );
    }
    if (pending?.stage !== 'zone') return false;
    if (loc.zone === 'emz' && !pending.allowEmz) return false;
    if (pending.zone === 'monster' && (loc.zone === 'mz' || loc.zone === 'emz')) {
      const occ = state[loc.zone][loc.index];
      if (loc.zone === 'emz' && state.opp?.emz?.[loc.index]) return false;
      return !occ || pending.picked.includes(occ);
    }
    if (pending.zone === 'stz' && loc.zone === 'stz') return !state.stz[loc.index];
    return false;
  };

  const onZoneClick = (loc: Location) => {
    if (run) return onRunResult(completeStep(run, ctx, loc), run);
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
      free: true,
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
    free: true,
    onClick: () => dispatch({ type: 'ACTIVATE_EFFECT', uid }),
  });

  const commonMoves = (uid: string, loc: Location): Btn[] => {
    const btns: Btn[] = [];
    if (loc.zone !== 'hand')
      btns.push({ label: '手札へ', dest: 'hand', onClick: () => dispatch(move(uid, { zone: 'hand' })) });
    if (loc.zone !== 'gy')
      btns.push({ label: '墓地へ', dest: 'gy', onClick: () => dispatch(move(uid, { zone: 'gy' })) });
    if (loc.zone !== 'banished')
      btns.push({ label: '除外', dest: 'banished', onClick: () => dispatch(move(uid, { zone: 'banished' })) });
    if (loc.zone === 'banished' || loc.zone === 'gy' || loc.zone === 'hand') {
      btns.push({
        label: '裏側で除外',
        dest: 'banished',
        onClick: () => dispatch({ type: 'MOVE', uid, to: { zone: 'banished' }, faceUp: false }),
      });
    }
    btns.push({ label: 'デッキの上へ', dest: 'deck', onClick: () => dispatch(move(uid, { zone: 'deck' })) });
    btns.push({
      label: 'デッキの下へ',
      dest: 'deck',
      onClick: () => dispatch(move(uid, { zone: 'deck' }, undefined, true)),
    });
    return btns.map((b) => ({ ...b, free: true }));
  };

  /** 練習用に置いた相手のカードの操作 */
  const oppButtons = (uid: string, loc: Location): Btn[] => {
    const inst = state.cards[uid];
    const onField = ['omz', 'oemz', 'ostz', 'ofz'].includes(loc.zone);
    const btns: Btn[] = [];
    // 相手ターンのバトルフェイズ：相手のモンスターで攻撃する（練習）
    if ((loc.zone === 'omz' || loc.zone === 'oemz') && state.opponentTurn && state.phase === 'BP' && !state.battle) {
      const mine = [...state.mz, ...state.emz].filter((u): u is string => !!u);
      for (const t of mine)
        btns.push({
          label: `相手の攻撃：${state.cards[t].faceUp ? def(t).name : '裏側のモンスター'}に攻撃`,
          primary: true,
          onClick: () => dispatch({ type: 'ATTACK', uid, target: t }),
        });
      if (!mine.length)
        btns.push({ label: '相手の攻撃：直接攻撃', primary: true, onClick: () => dispatch({ type: 'ATTACK', uid }) });
    }
    if (onField) {
      btns.push({ label: '破壊する（相手の墓地へ）', onClick: () => dispatch(move(uid, { zone: 'gy' }, '破壊')) });
      btns.push({ label: '除外する', onClick: () => dispatch(move(uid, { zone: 'banished' }, '除外')) });
      btns.push({ label: '手札に戻す', onClick: () => dispatch(move(uid, { zone: 'hand' }, 'バウンス')) });
      if (loc.zone === 'omz' || loc.zone === 'oemz') {
        if (inst.faceUp)
          btns.push({
            label: inst.position === 'atk' ? '守備表示にする' : '攻撃表示にする',
            onClick: () =>
              dispatch({ type: 'OPP_EDIT', uid, faceUp: true, position: inst.position === 'atk' ? 'def' : 'atk' }),
          });
        btns.push({
          label: inst.faceUp ? '裏側守備表示にする' : '表側にする',
          onClick: () => dispatch({ type: 'OPP_EDIT', uid, faceUp: !inst.faceUp, position: 'def' }),
        });
      } else {
        btns.push({
          label: inst.faceUp ? '裏側にする' : '表側にする',
          onClick: () => dispatch({ type: 'OPP_EDIT', uid, faceUp: !inst.faceUp }),
        });
      }
    }
    btns.push({ label: '取り除く（置き間違い）', onClick: () => dispatch({ type: 'OPP_REMOVE', uid }) });
    return btns;
  };

  const buttonsFor = (uid: string): Btn[] => {
    const d = def(uid);
    const inst = state.cards[uid];
    const loc = findLocation(state, uid);
    if (!loc) return [];
    if (inst.opp) return oppButtons(uid, loc);
    const btns: Btn[] = [];
    const script = CARD_SCRIPTS[d.id];
    const scriptedActivation = !!script?.effects?.some((e) => e.isCardActivation);
    for (const e of script?.effects ?? []) {
      if (!effectAvailable(state, uid, e)) continue;
      if (effectUsedUp(state, ctx, uid, e)) {
        btns.push({ label: e.label, used: true, onClick: () => {} });
        continue;
      }
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
                build: (picked, z) => ({
                  type: 'NORMAL_SUMMON',
                  uid,
                  index: (z as MonsterLocation).index,
                  tributes: picked,
                  grant: gi,
                }),
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
                build: (_, z) => ({
                  type: 'NORMAL_SUMMON',
                  uid,
                  index: (z as MonsterLocation).index,
                  noTributeGrant: gi,
                }),
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
        if (
          state.phase === 'BP' &&
          !state.opponentTurn &&
          !state.battle &&
          (inst.position === 'atk' || canAttackInDefense(state, ctx, uid))
        ) {
          // 相手フィールドにモンスターがいれば、攻撃するモンスターを選ぶ（直接攻撃できるのはトゥーンなど）
          const targets = view.opp ? oppMonsterSlots(view.opp).filter((u): u is string => !!u) : [];
          for (const t of targets)
            btns.push({
              label: `攻撃：${state.cards[t].faceUp ? def(t).name : '裏側守備表示のモンスター'}`,
              primary: true,
              onClick: () => dispatch({ type: 'ATTACK', uid, target: t }),
            });
          if (!targets.length || canAttackDirectly(state, ctx, uid))
            btns.push({ label: '直接攻撃', primary: true, onClick: () => dispatch({ type: 'ATTACK', uid }) });
        }
      } else {
        btns.push({ label: '反転召喚', onClick: () => dispatch({ type: 'FLIP_SUMMON', uid }) });
        btns.push({
          label: '表にする（効果で）',
          free: true,
          onClick: () =>
            dispatch({ type: 'MOVE', uid, to: loc, faceUp: true, position: inst.position, reason: '表側にする' }),
        });
      }
      btns.push({ label: 'リリース', free: true, onClick: () => dispatch(move(uid, { zone: 'gy' }, 'リリース')) });
      btns.push({
        label: 'ゾーン移動',
        dest: 'monster',
        free: true,
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
          free: true,
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
      if (inst.pendingResolve)
        btns.push({ label: '解決（墓地へ）', primary: true, onClick: () => dispatch({ type: 'RESOLVE', uid }) });
      if (!inst.faceUp && !scriptedActivation)
        btns.push({ label: '発動', primary: true, onClick: () => dispatch({ type: 'ACTIVATE_CARD', uid }) });
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
      if (loc.zone === 'deck')
        btns.push({
          label: '手札に加える',
          free: true,
          onClick: () => dispatch(move(uid, { zone: 'hand' }, 'サーチ')),
        });
      if (d.kind === 'monster') btns.push(...summonButtons(uid));
      else {
        btns.push({
          label: '魔法＆罠ゾーンに置く',
          dest: d.spellType === 'field' ? 'fz' : 'stz',
          free: true,
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

    // エンドフェイズの手札枚数調整（6枚を超えている時）
    if (loc.zone === 'hand' && state.hand.length > 6)
      btns.push({
        label: `捨てる（手札調整・${state.hand.length}枚）`,
        dest: 'gy',
        onClick: () => dispatch(move(uid, { zone: 'gy' }, '手札調整で捨てる')),
      });
    btns.push(...commonMoves(uid, loc));
    return btns;
  };

  // ===== ドラッグ＆ドロップ =====

  const DEST_OF: Record<string, DropDest> = {
    mz: 'monster',
    emz: 'monster',
    stz: 'stz',
    fz: 'fz',
    hand: 'hand',
    gy: 'gy',
    banished: 'banished',
    deck: 'deck',
  };

  /** そのカードを置ける場所か（置けない場所はドラッグしても反応しない） */
  const dropCheckerFor = (uid: string): ((target: string) => boolean) => {
    const from = findLocation(state, uid);
    if (!from) return () => false;
    const allowFree = oreRule || !session.strict;
    const dests = new Set(
      buttonsFor(uid)
        .filter((b) => b.dest && (allowFree || !b.free))
        .map((b) => b.dest!),
    );
    const d = def(uid);
    // 手札からアドバンス召喚するモンスターは、リリースするモンスターのゾーンにも出せる
    const tribute = from.zone === 'hand' && d.kind === 'monster' && tributesRequired(d.level ?? 0) > 0;
    return (target) => {
      const [zone, idx] = target.split(':');
      const dest = DEST_OF[zone];
      if (!dest || !dests.has(dest)) return false;
      if (from.zone === zone && idx === undefined) return false;
      if (idx === undefined) return true;
      const i = Number(idx);
      if ('index' in from && from.zone === zone && from.index === i) return false;
      if (zone === 'stz') return !state.stz[i];
      if (zone === 'emz') return from.zone === 'extra' && !state.emz[i] && !state.opp?.emz?.[i];
      if (zone === 'mz') return !state.mz[i] || (tribute && !state.cards[state.mz[i]!].opp);
      return true;
    };
  };

  const onDrop = (uid: string, target: string, x: number, y: number) => {
    if (run || pending || !state.cards[uid]) return;
    // 置けない場所に落とした時は何もしない
    if (!dropCheckerFor(uid)(target)) return;
    const [zone, idx] = target.split(':');
    const loc: Location | null =
      zone === 'mz' || zone === 'emz' || zone === 'stz'
        ? ({ zone, index: Number(idx) } as Location)
        : zone === 'fz'
          ? { zone: 'fz' }
          : null;
    const dest = DEST_OF[zone];
    const from = findLocation(state, uid);
    if (!dest || (from && loc && JSON.stringify(from) === JSON.stringify(loc))) return;
    if (from?.zone === zone && !loc) return;
    // 俺ルールがオフなら、本来できない移動はドラッグでもしない（ルールチェックがオフなら自由）
    const allowFree = oreRule || !session.strict;
    const options = buttonsFor(uid)
      .filter((b) => b.dest === dest && (allowFree || !b.free))
      .map((b) => ({
        ...b,
        onClick: () => {
          presetRef.current = loc;
          b.onClick();
          presetRef.current = null;
        },
      }));
    if (options.length === 1) options[0].onClick();
    else setDropMenu({ x, y, title: def(uid).name, options });
  };

  const { drag, dragStart, onClickCapture } = useDrag(onDrop);
  // ドラッグ中のカードを置ける場所（光らせる）
  const dropOk = useMemo(
    () => (drag && state.cards[drag.uid] ? dropCheckerFor(drag.uid) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag?.uid, state, oreRule],
  );
  const dropTarget = drag?.target && dropOk?.(drag.target) ? drag.target : null;

  // ===== 練習（次の手の表示） =====

  const coachDone = useMemo(() => (coach ? coachProgress(coach, state) : 0), [coach, state]);
  const coachStep = coach?.steps[coachDone];
  /** 次の手で実行する操作（ガイドは今の盤面から探す） */
  const coachAction = useMemo(() => {
    if (!coach || !coachStep) return undefined;
    if (coachStep.action) return applyAction(state, coachStep.action, ctx).ok ? coachStep.action : undefined;
    const guideDef = GUIDES.find((g) => g.id === coach.guideId);
    const gs = guideDef?.steps[coachDone];
    return gs ? (findGuideAction(state, ctx, gs) ?? undefined) : undefined;
  }, [coach, coachStep, coachDone, state, ctx]);
  const hl = actionHighlights(coach && !run && !pending ? coachAction : undefined);

  /** 新しいゲームを始める（盤面の選択状態・練習をリセット） */
  const newGame = (s: SessionData, naviOn: boolean) => {
    setSession(s);
    setCoach(null);
    setSelected(null);
    setPending(null);
    setRun(null);
    setPile(null);
    setNavi(naviOn);
    naviKey.current = '';
    setHome(false);
    setModal(null);
  };

  const startGuide = (g: Guide) => {
    setSession({ deckName: g.deckName, seed: g.seed, fixedHand: g.fixedHand, handSize: 5, strict: true, actions: [] });
    setCoach(coachFromGuide(g));
    setHome(false);
    setModal(null);
    setSelected(null);
    setPending(null);
    setRun(null);
  };

  const autoPlay = (actions: Action[]) => {
    setModal(null);
    let i = 0;
    const tick = () => {
      if (i >= actions.length || !dispatch(actions[i])) return;
      i++;
      if (i < actions.length) setTimeout(tick, 400);
    };
    tick();
  };

  // ナビ：練習中のルートが無い・外れたら、今の盤面から探し直す
  const boardKey = `${session.deckName}:${session.seed}:${session.fixedHand.join(',')}:${session.actions.length}`;
  const naviNeedsSearch =
    navi &&
    !run &&
    !pending &&
    state.status === 'playing' &&
    !state.opponentTurn &&
    (state.phase === 'M1' || state.phase === 'M2') &&
    (!coach || (!!coachStep && !coachAction));
  useEffect(() => {
    if (!naviNeedsSearch || routeSearch.searching || naviKey.current === boardKey) return;
    naviKey.current = boardKey;
    routeSearch.search(state, session.actions.length, deck.name);
  }, [naviNeedsSearch, boardKey, routeSearch, state, session.actions.length, deck.name]);

  // ナビ：探し終わったら一番良いルートで解説を始める
  useEffect(() => {
    const found = routeSearch.routes;
    if (!navi || !found || routeSearch.baseActions !== session.actions.length) return;
    if (found.length === 0) {
      setError('この盤面から動ける展開は見つかりませんでした');
      return;
    }
    const best = found[0];
    setCoach(coachFromRoute(best.title ?? '最適ルート', best.steps, best.summary, routeSearch.baseLog, best.finalUids));
    setPopupOpen(false);
    // 探し終わった結果だけに反応する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSearch.routes]);

  // 次の手に進んだら解説は閉じて、盤面で操作できるようにする（完成した時だけ開いてまとめを見せる）
  useEffect(() => setPopupOpen(!!coach && coachDone >= coach.steps.length), [coachDone, coach]);

  const nameOf = (uid: string) => (state.cards[uid] ? def(uid).name : 'トークン');
  const coachWhy = coach ? explainStep(coach, coachDone, nameOf) : [];

  // エラーは数秒で消す
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // ===== カード画像 =====

  /** 保存できたら true */
  const setCardImage = async (cardId: string, file: File | undefined): Promise<boolean> => {
    if (!file) return false;
    try {
      const url = await fileToDataUrl(file);
      if (!saveImage(cardId, url)) {
        setError('ブラウザの保存容量が足りず、画像を保存できませんでした');
        return false;
      }
      setImages((m) => ({ ...m, [cardId]: url }));
      return true;
    } catch {
      setError('画像を読み込めませんでした（JPEG・PNGなどの画像を選んでください）');
      return false;
    }
  };

  const clearCardImage = (cardId: string) => {
    removeImage(cardId);
    setImages((m) => {
      const next = { ...m };
      delete next[cardId];
      return next;
    });
  };

  const imagePicker = (cardId: string, label: string, small = false) => (
    <label className={`file-btn ${small ? 'small' : ''}`}>
      {label}
      <input
        type="file"
        accept="image/*"
        onChange={(e) => {
          void setCardImage(cardId, e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </label>
  );

  // ===== チェーン =====

  const chain = state.chain ?? [];
  const chainResponses = chain.length ? chainableEffects(state, ctx, chain[chain.length - 1].speed) : [];
  const battle = state.battle ?? null;
  // 戦闘の今の段階で発動できる効果
  const battleEffects = battle && !chain.length && !run && !pending ? chainableEffects(state, ctx, 0, true) : [];
  const chainOf = Object.fromEntries(chain.map((l, i) => [l.uid, i + 1]));

  // 「解決する」を押したら、チェーンが無くなるまで上から順に解決する（途中の選択は都度聞く）
  useEffect(() => {
    if (!resolvingChain || run || pending) return;
    if (!chain.length) {
      setResolvingChain(false);
      return;
    }
    onRunResult(startResolve(state, ctx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvingChain, chain.length, run, pending]);

  // ===== 表示 =====

  // 演出：1手戻す・新しいゲーム・効果の取り消しでは動かさない
  const motionKey = `${session.deckName}:${session.seed}:${session.fixedHand.join(',')}:${session.handSize}`;
  const motionPrev = useRef({ key: motionKey, count: session.actions.length, run: !!run });
  const animateMotion =
    motionPrev.current.key === motionKey &&
    session.actions.length >= motionPrev.current.count &&
    !(motionPrev.current.run && !run && session.actions.length === motionPrev.current.count);
  useEffect(() => {
    motionPrev.current = { key: motionKey, count: session.actions.length, run: !!run };
  });

  const selDef = sel ? def(sel) : null;
  // 別のカードを開いたら、俺ルールの操作は閉じておく
  useEffect(() => setFreeOpen(false), [sel]);
  const selLoc = sel ? findLocation(state, sel) : null;
  // 効果処理中は途中経過の盤面を表示する
  const view = run?.temp ?? state;
  const vdef = (uid: string) => getDef(view, ctx, uid);
  const oppPileKey = (z: OppPile) => (z === 'ogy' ? 'gy' : z === 'obanished' ? 'banished' : 'hand');
  const pileCards = !pile
    ? []
    : pile === 'ogy' || pile === 'obanished' || pile === 'ohand'
      ? (view.opp?.[oppPileKey(pile)] ?? [])
      : view[pile];
  const opp = view.opp;
  const showOpp =
    oppMode ||
    (!!opp &&
      (opp.mz.some(Boolean) ||
        !!opp.emz?.some(Boolean) ||
        opp.stz.some(Boolean) ||
        !!opp.fz ||
        opp.gy.length + opp.banished.length + opp.hand.length > 0));
  const runStep = run && currentStep(run);
  const runCands = run ? stepCandidates(run, ctx) : [];
  const [runMin, runMax] = run ? pickRange(run, ctx) : [0, 0];
  const busy = !!(run || pending);

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
      navigator.clipboard
        ?.writeText(text)
        .catch(() => setError('コピーできませんでした。ログを長押しして選択してください'));
    } catch {
      setError('コピーできませんでした。ログを長押しして選択してください');
    }
  };

  // 手札は画面幅に収まるよう重ねて並べる
  const handStep = (() => {
    const n = view.hand.length;
    const avail = Math.min(winWidth, 960) - 24;
    const w = handCardWidth(winWidth, winHeight);
    if (n <= 1) return w + 6;
    return Math.min(w + 6, (avail - w) / (n - 1));
  })();

  // 山札などの一覧を開いたままカードを選んだ時：横に広い画面では一覧を右へ寄せ、カードの詳細を左の空きに出す
  const pileSide = winWidth >= 900;
  const peekButton = <button onClick={() => setPeek(true)}>フィールドを確認</button>;
  const actionPanel = pending ? (
    <div className="action-panel">
      <div className="ap-title">{pending.title}</div>
      <div className="ap-hint">
        {pending.stage === 'pick'
          ? `${pending.hint}　選択中：${pending.picked.map((u) => def(u).name).join('、') || 'なし'}`
          : '光っているゾーンを選んでください'}
      </div>
      <div className="btn-row">
        {pending.stage === 'pick' && !pending.single && (
          <button className="primary" onClick={() => confirmPick(pending)}>
            決定
          </button>
        )}
        {pending.stage === 'pick' && pending.pickFrom?.includes('gy') && (
          <button onClick={() => setPile('gy')}>墓地を開く</button>
        )}
        {peekButton}
        <button onClick={() => setPending(null)}>キャンセル</button>
      </div>
    </div>
  ) : run ? (
    <div className="action-panel">
      <div className="ap-title">{run.title}</div>
      <div className="ap-hint">
        {run.stage === 'zone'
          ? runStep?.op === 'place'
            ? runStep.prompt
            : '光っているゾーンを選んでください'
          : run.stage === 'mode'
            ? '処理を選んでください'
            : runStep?.op === 'pick'
              ? `${runStep.prompt}（${runMin === runMax ? runMin : `${runMin}〜${runMax}`}枚）`
              : ''}
      </div>
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
            onClick={() => onRunResult(afterPick(run, ctx), run)}
          >
            決定（{run.picked.length}枚）
          </button>
        )}
        {run.stage === 'pick' && runMin === 0 && (
          <button onClick={() => onRunResult(afterPick({ ...run, picked: [] }, ctx), run)}>選ばない</button>
        )}
        {run.stage === 'mode' &&
          runStep?.op === 'pick' &&
          runStep.modes?.map((m, i) => (
            <button
              key={m}
              className="primary"
              onClick={() => onRunResult(afterPick({ ...run, mode: i, stage: 'mode' }, ctx), run)}
            >
              {m}
            </button>
          ))}
        {peekButton}
        {run.resolving ? (
          <>
            <button
              onClick={() => {
                const a = fizzleTop(state, ctx);
                setRun(null);
                if (a) dispatch(a);
              }}
            >
              処理できない（不発にする）
            </button>
            <button
              onClick={() => {
                setResolvingChain(false);
                setRun(null);
              }}
            >
              中断（チェーン画面に戻る）
            </button>
          </>
        ) : (
          <button onClick={() => setRun(null)}>キャンセル</button>
        )}
      </div>
    </div>
  ) : chain.length ? (
    <div className="action-panel chain-panel">
      <div className="ap-title">チェーン {chain.length}</div>
      <ol className="chain-list">
        {[...chain].reverse().map((l, i) => (
          <li key={chain.length - i} className={`${l.opp ? 'opp-link' : ''} ${l.negated ? 'negated' : ''}`}>
            <span className="chain-no">C{chain.length - i}</span>
            {l.opp && <strong className="opp-tag">相手</strong>}
            {CARD_DB[l.defId]?.name}：{l.label}
            {l.negated && <strong className="neg-tag">{l.negated === 'destroy' ? '無効・破壊' : '無効'}</strong>}
          </li>
        ))}
      </ol>
      {chainResponses.length > 0 ? (
        <>
          <div className="ap-hint">さらにチェーンできる効果（後から発動したものから解決します）</div>
          <div className="btn-row">
            {chainResponses.map((c) => (
              <button key={`${c.uid}-${c.effect.label}`} onClick={() => runEffect(c.uid, c.effect)}>
                {def(c.uid).name}：{c.effect.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="ap-hint">これ以上チェーンできる効果はありません。</div>
      )}
      <div className="ap-hint">
        効果はまだ処理されていません。チェーンしないなら「チェーンを解決する」を押してください。
      </div>
      <div className="btn-row">
        <button className="primary" onClick={() => setResolvingChain(true)}>
          チェーンを解決する（C{chain.length}から）
        </button>
      </div>
    </div>
  ) : battle && state.cards[battle.attacker] ? (
    <div className="action-panel battle-panel">
      <div className="ap-title">
        戦闘：{battle.byOpp ? '相手の' : ''}
        {def(battle.attacker).name} →{' '}
        {battle.target
          ? state.cards[battle.target]?.faceUp === false
            ? '裏側守備表示のモンスター'
            : state.cards[battle.target]
              ? def(battle.target).name
              : '（いなくなった）'
          : '直接攻撃'}
      </div>
      <ol className="battle-steps">
        {(['battle', 'damage', 'calc', 'end'] as const).map((st) => (
          <li key={st} className={st === battle.step ? 'now' : ''}>
            {BATTLE_STEP_LABEL[st]}
          </li>
        ))}
      </ol>
      {battleEffects.length > 0 ? (
        <>
          <div className="ap-hint">この段階で発動できる効果</div>
          <div className="btn-row">
            {battleEffects.map((c) => (
              <button key={`${c.uid}-${c.effect.label}`} onClick={() => runEffect(c.uid, c.effect)}>
                {def(c.uid).name}：{c.effect.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="ap-hint">この段階で発動できる効果はありません。</div>
      )}
      <div className="btn-row">
        <button className="primary" onClick={() => dispatch({ type: 'BATTLE_STEP' })}>
          {battle.step === 'battle'
            ? 'ダメージステップへ'
            : battle.step === 'damage'
              ? 'ダメージ計算へ'
              : battle.step === 'calc'
                ? 'ダメージ計算をする'
                : 'ダメージステップを終える'}
        </button>
      </div>
    </div>
  ) : null;

  /**
   * お手本を実行する。相手の盤面に妨害があり、この効果の発動に相手がチェーンしてくる場合は、
   * 一気に処理せずに効果の発動から始めて（選択は自分で行う）、相手の妨害を受ける
   */
  const runDemo = () => {
    if (!coachAction) return;
    const first = coachAction.type === 'BATCH' ? coachAction.actions[0] : coachAction;
    if (session.strict && first && (first.type === 'ACTIVATE_EFFECT' || first.type === 'ACTIVATE_CARD')) {
      const uid = first.uid;
      const effects = state.cards[uid] ? (CARD_SCRIPTS[state.cards[uid].defId]?.effects ?? []) : [];
      const effect =
        first.type === 'ACTIVATE_CARD'
          ? effects.find((e) => e.isCardActivation)
          : effects.find((e) => e.label === first.label);
      if (effect && oppWouldRespond(state, ctx, uid, effectSpeed(state, ctx, uid, effect))) {
        runEffect(uid, effect);
        setError('相手が妨害してきそうです。効果の選択は自分で行ってください（解説の通りに選ぶ）');
        return;
      }
    }
    dispatch(coachAction);
  };

  const quitCoach = () => {
    setCoach(null);
    setNavi(false);
  };

  const coachBar = coach && !busy && !popupOpen && (
    <div className={`coach ${coachStep ? '' : 'finished'}`}>
      {coachStep ? (
        <>
          <div className="coach-head">
            <span className="coach-count">
              次の手 {coachDone + 1}/{coach.steps.length}
            </span>
            <span className="coach-title">{coach.title}</span>
          </div>
          <div className="coach-text">{coachStep.text}</div>
          {coachStep.sub.length > 0 && <div className="coach-sub">{coachStep.sub.join(' → ')}</div>}
          {!coachAction && (
            <div className="coach-sub warn">今の盤面ではこの手を実行できません（ルートから外れたかもしれません）</div>
          )}
        </>
      ) : (
        <>
          <div className="coach-head">
            <span className="coach-count">完成</span>
            <span className="coach-title">{coach.title}</span>
          </div>
          <div className="coach-sub">{coach.summary.slice(0, 4).join(' ／ ')}</div>
        </>
      )}
      <div className="coach-btns">
        <button className="primary" onClick={() => setPopupOpen(true)}>
          解説
        </button>
        {coachStep && (
          <button disabled={!coachAction} onClick={runDemo}>
            お手本
          </button>
        )}
        <button onClick={quitCoach} aria-label="練習をやめる">
          ×
        </button>
      </div>
    </div>
  );

  const naviSearching = navi && routeSearch.searching && !busy && (
    <div className="coach searching">
      <div className="coach-head">
        <span className="coach-count">ナビ</span>
        <span className="coach-title">この盤面から最適ルートを計算中… {Math.round(routeSearch.progress * 100)}%</span>
      </div>
      <div className="progress" aria-hidden="true">
        <div style={{ width: `${Math.round(routeSearch.progress * 100)}%` }} />
      </div>
    </div>
  );

  const showStepPopup =
    coach && popupOpen && !busy && !chain.length && !dropMenu && !sel && !pile && !modal && !showSetup && !home;
  // 横に空きがあれば盤面の右に、無ければ盤面を上に寄せて下の空きに出す
  const dockRight = winWidth >= 900;

  return (
    <CardImageContext.Provider value={shownImages}>
      <div
        className={`app ${busy ? 'busy' : ''} ${drag ? 'dragging' : ''} ${showOpp ? 'with-opp' : ''} ${
          showStepPopup && !dockRight ? 'with-popup' : ''
        }`}
        style={
          {
            '--hand-w': `${handCardWidth(winWidth, winHeight)}px`,
            '--hand-h': `${handHeight}px`,
            '--coach-h': `${coachHeight}px`,
          } as React.CSSProperties
        }
        onClickCapture={onClickCapture}
      >
        <header className="hud">
          <div className="hud-status">
            <button className="chip deck-chip" onClick={() => setHome(true)} aria-label="メニュー画面（デッキ選択）">
              {deck.name}
            </button>
            <span className="chip">T{state.turn}</span>
            <span className={`chip phase ${state.opponentTurn ? 'opp' : ''}`}>
              {state.opponentTurn ? '相手ターン' : PHASE_LABEL[state.phase]}
            </span>
            <span className="chip">LP {state.lp}</span>
            {state.opponentLp < 8000 && <span className="chip">相手 {state.opponentLp}</span>}
            <span className={`chip ${state.normalSummonUsed ? 'used' : 'avail'}`}>
              召喚{state.normalSummonUsed ? '済' : '可'}
            </span>
            {state.summonGrants.length > 0 && <span className="chip avail">追加召喚あり</span>}
            {!session.strict && <span className="chip free">フリー</span>}
            {state.status !== 'playing' && (
              <span className="chip result">{state.status === 'won' ? '勝利' : '敗北'}</span>
            )}
          </div>
          <div className="hud-actions">
            <button onClick={undo} disabled={session.actions.length === 0} aria-label="1手戻す">
              戻す
            </button>
            {state.opponentTurn ? (
              <button className="primary" onClick={() => dispatch({ type: 'END_TURN' })}>
                自分のターンへ
              </button>
            ) : state.phase === 'EP' ? (
              <button className="primary" onClick={() => dispatch({ type: 'END_TURN', toOpponent: true })}>
                相手ターンへ
              </button>
            ) : (
              <button className="primary" onClick={() => dispatch({ type: 'NEXT_PHASE' })}>
                次のフェイズ
              </button>
            )}
            <button
              className={navi ? 'primary' : 'accent'}
              aria-pressed={navi}
              onClick={() => {
                if (navi) quitCoach();
                else {
                  setNavi(true);
                  setCoach(null);
                  naviKey.current = '';
                }
              }}
            >
              ナビ{navi ? 'ON' : ''}
            </button>
            <button onClick={() => setModal('routes')}>ルート</button>
            <button onClick={() => setModal('menu')} aria-label="メニュー">
              ≡
            </button>
          </div>
        </header>

        <main className="table">
          {(naviSearching || coachBar) && (
            <div ref={coachRef} className="coach-wrap">
              {naviSearching || coachBar}
            </div>
          )}
          {peek && (run || pending) ? (
            <button className="peek-back primary" onClick={() => setPeek(false)}>
              選択に戻る（{(run ?? pending)!.title}）
            </button>
          ) : (
            actionPanel
          )}
          <div className="board-wrap">
            <Board
              state={view}
              ctx={ctx}
              selected={sel}
              picked={pending?.picked ?? []}
              zoneSelectable={zoneSelectable}
              onCardClick={onCardClick}
              onZoneClick={onZoneClick}
              onPileClick={(z) => setPile(pile === z ? null : z)}
              dragStart={busy ? undefined : dragStart}
              dropTarget={dropTarget}
              dropOk={dropOk}
              hintCards={hl.cards}
              hintZones={hl.zones}
              chainOf={chainOf}
              showOpp={showOpp}
              onOppZoneClick={(loc) => !busy && setOppPlace(loc)}
              onOppPileClick={(z) => setPile(pile === z ? null : z)}
            />
          </div>
        </main>

        <section
          ref={handRef}
          className={`hand-strip ${dropTarget === 'hand' ? 'drop-over' : dropOk?.('hand') ? 'drop-ok' : ''}`}
          data-drop="hand"
          data-pile="hand"
        >
          <div className="hand-cards">
            {view.hand.map((u, i) => (
              <div
                key={u}
                className={`hand-slot ${hl.cards.includes(u) ? 'hint' : ''}`}
                style={{ marginLeft: i === 0 ? 0 : handStep - handCardWidth(winWidth, winHeight), zIndex: i }}
              >
                <CardView
                  def={vdef(u)}
                  selected={sel === u}
                  highlighted={pending?.picked.includes(u) || run?.picked.includes(u)}
                  onClick={() => onCardClick(u)}
                  onPointerDown={busy ? undefined : dragStart(u)}
                  uid={u}
                />
              </div>
            ))}
            {view.hand.length === 0 && <span className="note">手札なし</span>}
          </div>
        </section>

        {!home && <MotionLayer view={view} ctx={ctx} animate={animateMotion} />}

        {showStepPopup && (
          <StepPopup
            dockRight={dockRight}
            coach={coach}
            done={coachDone}
            canDemo={!!coachAction}
            why={coachWhy}
            onTry={() => setPopupOpen(false)}
            onDemo={runDemo}
            onUndo={undo}
            onShowAll={() => setModal('routes')}
            onRecalc={() => {
              setCoach(null);
              setNavi(true);
              naviKey.current = '';
            }}
            onRestart={() => setSession((x) => ({ ...x, actions: [] }))}
            onQuit={quitCoach}
          />
        )}

        {error && (
          <div className="toast" role="alert" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        {/* 相手のゾーンにカードを置く（練習） */}
        {oppPlace && (
          <OppPlaceSheet
            to={oppPlace}
            onPlace={(a) => {
              if (dispatch(a)) setOppPlace(null);
            }}
            onClose={() => setOppPlace(null)}
          />
        )}

        {/* カード詳細 */}
        {sel && selDef && selLoc && !busy && !dropMenu && (
          <div
            className={`sheet-backdrop ${pile ? (pileSide ? 'beside-pile' : 'over-pile') : ''}`}
            onClick={() => setSelected(null)}
          >
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h2>{selDef.name}</h2>
                <button onClick={() => setSelected(null)}>閉じる</button>
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
              <div className={`detail-body ${shownImages[selDef.id] ? 'with-img' : ''}`}>
                {shownImages[selDef.id] && (
                  <img className="detail-img" src={shownImages[selDef.id]} alt={selDef.name} />
                )}
                <CardText text={selDef.text} />
              </div>
              <div className="btn-row">
                {imagePicker(selDef.id, shownImages[selDef.id] ? '画像を変更' : '画像を設定')}
                {images[selDef.id] && (
                  <button onClick={() => clearCardImage(selDef.id)}>
                    {BUILTIN_IMAGES[selDef.id] ? '最初の画像に戻す' : '画像を外す'}
                  </button>
                )}
              </div>
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
              {(() => {
                const all = buttonsFor(sel);
                const showFree = oreRule || !session.strict;
                const legal = showFree ? all : all.filter((b) => !b.free);
                const free = showFree ? [] : all.filter((b) => b.free);
                const grid = (list: Btn[]) => (
                  <div className="btn-grid">
                    {list.map((b) => (
                      <button
                        key={b.label}
                        className={[
                          b.primary ? 'primary' : '',
                          b.used ? 'used' : '',
                          b.label.length > 10 || b.used ? 'wide' : '',
                        ].join(' ')}
                        disabled={b.used}
                        onClick={() => {
                          b.onClick();
                          setSelected(null);
                          setPile(null);
                          setFreeOpen(false);
                        }}
                      >
                        {b.used && <span className="used-tag">使用済み</span>}
                        {b.label}
                      </button>
                    ))}
                  </div>
                );
                return (
                  <>
                    {legal.length > 0 ? grid(legal) : <p className="note">今できる操作はありません。</p>}
                    {free.length > 0 &&
                      (freeOpen ? (
                        <div className="ore-rule">
                          <div className="ore-head">俺ルール（本来はできない操作）</div>
                          {grid(free)}
                        </div>
                      ) : (
                        <button className="ore-toggle" onClick={() => setFreeOpen(true)}>
                          俺ルールで操作する（墓地へ・除外・デッキへ戻すなど）
                        </button>
                      ))}
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* デッキ・墓地・除外・EXの中身 */}
        {pile && (
          <div className={`modal-backdrop ${pileSide && sel ? 'pile-right' : ''}`} onClick={() => setPile(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h2>
                  {ZONE_LABEL[pile]}（{pileCards.length}枚）
                </h2>
                <button onClick={() => setPile(null)}>閉じる</button>
              </div>
              {pile === 'deck' && <p className="note">左上がデッキの一番上です。</p>}
              {busy && <p className="note">カードをタップして選択できます。</p>}
              <div className="pile-cards">
                {(pile === 'deck' || pile === 'extra' ? pileCards : [...pileCards].reverse()).map((u) => (
                  <CardView
                    key={u}
                    def={vdef(u)}
                    inst={pile === 'banished' || pile === 'obanished' ? view.cards[u] : undefined}
                    selected={sel === u}
                    highlighted={pending?.picked.includes(u) || run?.picked.includes(u)}
                    onClick={() => onCardClick(u)}
                    small
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ルート（探索・ガイド） */}
        <div className="modal-backdrop" hidden={modal !== 'routes'} onClick={() => setModal(null)}>
          <RoutePanel
            search={routeSearch}
            state={state}
            actionCount={session.actions.length}
            deckName={deck.name}
            guides={GUIDES}
            coach={coach}
            coachDone={coachDone}
            onPractice={(c) => {
              setCoach(c);
              setModal(null);
            }}
            onAutoPlay={autoPlay}
            onStartGuide={startGuide}
            onClose={() => setModal(null)}
          />
        </div>

        {/* メニュー */}
        {modal === 'menu' && (
          <div className="modal-backdrop" onClick={() => setModal(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h2>メニュー</h2>
                <button onClick={() => setModal(null)}>閉じる</button>
              </div>
              <div className="btn-grid">
                <button
                  className="primary wide"
                  onClick={() => {
                    setModal(null);
                    setHome(true);
                  }}
                >
                  メニュー画面（デッキ選択・新しいゲーム）
                </button>
                <button
                  onClick={() => {
                    setModal(null);
                    setShowSetup(true);
                  }}
                >
                  新しいゲーム（手札を選ぶ）
                </button>
                <button
                  onClick={() => {
                    setSession((s) => ({ ...s, actions: [] }));
                    setModal(null);
                  }}
                  disabled={session.actions.length === 0}
                >
                  同じ初手で最初から
                </button>
                <button onClick={() => dispatch({ type: 'END_TURN' })}>ターン終了</button>
                <button className={oreRule ? 'on' : ''} aria-pressed={oreRule} onClick={() => setOreRule(!oreRule)}>
                  俺ルール（本来できない操作も常に表示）：{oreRule ? 'ON' : 'OFF'}
                </button>
                <div className="wide opp-presets">
                  <div className="ore-head">相手の妨害（相手がトゥーンの最終盤面・チェーンして止めてくる）</div>
                  <div className="btn-row">
                    {OPP_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        title={p.description}
                        onClick={() => {
                          if (dispatch(oppPresetAction(state, p))) {
                            setOppMode(true);
                            setModal(null);
                          }
                        }}
                      >
                        {p.name}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        dispatch(oppPresetAction(state, null));
                        setModal(null);
                      }}
                    >
                      なし
                    </button>
                  </div>
                  <p className="note">
                    1妨害：バロネス／2：＋トゥーン・テラー／3：＋ア＝バオ・ア・クゥー／4：＋ゲオルギアス③（記事の最終盤面）。こちらが効果を発動すると、相手が妨害をチェーンしてきます。
                  </p>
                </div>
                <button className={oppMode ? 'on' : ''} aria-pressed={oppMode} onClick={() => setOppMode(!oppMode)}>
                  相手の盤面を置く（練習）：{oppMode ? 'ON' : 'OFF'}
                </button>
                {!state.opponentTurn && (
                  <button
                    onClick={() => {
                      dispatch({ type: 'END_TURN', toOpponent: true });
                      setModal(null);
                    }}
                  >
                    相手ターンへ（妨害の練習）
                  </button>
                )}
                <button onClick={() => dispatch({ type: 'DRAW' })}>1枚ドロー</button>
                <button onClick={() => dispatch({ type: 'SHUFFLE_DECK' })}>シャッフル</button>
                <button onClick={() => setShowToken((v) => !v)}>トークン生成</button>
                <button className="primary wide" onClick={() => setModal('decks')}>
                  デッキ編集・切り替え（現在：{deck.name}）
                </button>
                <button className="wide" onClick={() => setModal('images')}>
                  カード画像の設定
                </button>
                <label className="toggle wide">
                  <input
                    id="strict-toggle"
                    type="checkbox"
                    checked={session.strict}
                    onChange={(e) => setSession((s) => ({ ...s, strict: e.target.checked }))}
                  />
                  ルールチェック
                </label>
              </div>
              {showToken && (
                <TokenForm
                  onCreate={(t) => {
                    setModal(null);
                    start({
                      title: `${t.name}を生成`,
                      hint: '',
                      zone: 'monster',
                      build: (_, z) => ({ type: 'CREATE_TOKEN', ...t, to: z as MonsterLocation }),
                    });
                  }}
                />
              )}
              <div className="log-head">
                <strong>記録（{session.actions.length}手）</strong>
                <button onClick={copyLog}>コピー</button>
              </div>
              <ol className="log-list">
                {state.log.map((l, i) => (
                  <li key={i} className={`log-${l.kind}`}>
                    <span className="log-turn">T{l.turn}</span>
                    {l.text}
                  </li>
                ))}
              </ol>
              <div className="route-save">
                <input
                  id="route-name"
                  value={routeName}
                  placeholder={`記録の名前（例：${deck.name} シード${session.seed}）`}
                  onChange={(e) => setRouteName(e.target.value)}
                />
                <button onClick={saveRoute}>保存</button>
              </div>
              {routes.length > 0 && (
                <div className="routes">
                  {routes.map((r, i) => (
                    <div key={i} className="route-row">
                      <span className="grow">{r.name}</span>
                      <button
                        onClick={() => {
                          setSession({
                            deckName: r.deckName,
                            seed: r.seed,
                            fixedHand: r.fixedHand,
                            handSize: r.handSize,
                            strict: r.strict,
                            actions: r.actions,
                          });
                          setPending(null);
                          setSelected(null);
                          setCoach(null);
                          setModal(null);
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
            </div>
          </div>
        )}

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

        {home && (
          <HomeMenu
            decks={allDecks}
            builtinNames={BUILTIN_DECKS.map((d) => d.name)}
            current={deck.name}
            resume={session.actions.length ? { deckName: deck.name, actions: session.actions.length } : null}
            guides={GUIDES}
            onResume={() => setHome(false)}
            onRandom={(deckName, handSize, naviOn) =>
              newGame(
                { deckName, seed: randomSeed(), fixedHand: [], handSize, strict: session.strict, actions: [] },
                naviOn,
              )
            }
            onPickHand={(deckName) => {
              setSetupDeck(deckName);
              setShowSetup(true);
            }}
            onGuide={startGuide}
            onEditDecks={() => setModal('decks')}
            onImages={() => setModal('images')}
          />
        )}

        {showSetup && (
          <SetupDialog
            initial={{
              ...session,
              seed: randomSeed(),
              ...(setupDeck && setupDeck !== session.deckName ? { deckName: setupDeck, fixedHand: [] } : {}),
            }}
            decks={allDecks}
            onClose={() => {
              setShowSetup(false);
              setSetupDeck(null);
            }}
            onStart={(s, search) => {
              try {
                createGame(
                  allDecks.find((d) => d.name === s.deckName) ?? BUILTIN_DECKS[0],
                  replayCtx,
                  s.seed,
                  s.fixedHand,
                  s.handSize,
                );
              } catch (e) {
                setError((e as Error).message);
                return;
              }
              setSession(s);
              setCoach(null);
              setSelected(null);
              setPending(null);
              setRun(null);
              setPile(null);
              setShowSetup(false);
              setSetupDeck(null);
              setHome(false);
              // 「開始して最適ルートを探す」はナビモードで始める
              setNavi(search);
              naviKey.current = '';
            }}
          />
        )}

        {/* デッキ編集 */}
        {modal === 'decks' && (
          <div className="modal-backdrop" onClick={() => setModal(null)}>
            <DeckEditor
              decks={customDecks}
              current={deck.name}
              onSave={(list) => {
                if (!saveDecks(list)) setError('ブラウザの保存容量が足りず、デッキを保存できませんでした');
                setCustomDecks(list);
                // 使っていたデッキを消した場合は既製のデッキに戻す
                if (![...BUILTIN_DECKS, ...list].some((d) => d.name === session.deckName)) {
                  setSession({ ...defaultSession(), deckName: BUILTIN_DECKS[0].name });
                  setCoach(null);
                }
              }}
              onPlay={(deckName) =>
                newGame(
                  { deckName, seed: randomSeed(), fixedHand: [], handSize: 5, strict: session.strict, actions: [] },
                  false,
                )
              }
              onClose={() => setModal(null)}
            />
          </div>
        )}

        {/* カード画像の設定 */}
        {modal === 'images' && (
          <div className="modal-backdrop" onClick={() => setModal(null)}>
            <ImageSettings
              images={images}
              shown={shownImages}
              builtin={BUILTIN_IMAGES}
              decks={allDecks}
              current={deck.name}
              onSet={(id, f) => setCardImage(id, f)}
              onClear={clearCardImage}
              onClose={() => setModal(null)}
            />
          </div>
        )}
      </div>
    </CardImageContext.Provider>
  );
}

/** 手札のカードの幅（画面の大きさに合わせる） */
function handCardWidth(w: number, h: number): number {
  return Math.round(Math.max(58, Math.min(110, w / 5.4, (h - 120) / 6.2)));
}

/** 要素の高さを見張る */
function useElementHeight<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    if (!el) {
      setHeight(0);
      return;
    }
    setHeight(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height));
    observer.current.observe(el);
  }, []);
  return [ref, height];
}

function useWindowSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
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
