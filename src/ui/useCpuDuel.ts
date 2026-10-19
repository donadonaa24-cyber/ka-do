import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyHandTrap,
  type CpuStep,
  describeCpuStep,
  type HandTrapOption,
  handTrapOptions,
  humanSignature,
  reverseSync,
  specialSummonsBetween,
  syncAction,
} from '../engine/cpu';
import { type Action, applyAction, createGame, type Ctx, getDef, replay } from '../engine/game';
import type { RouteStep } from '../engine/solver';
import type { DeckList, GameState } from '../engine/types';
import SolverWorker from './solver.worker?worker&inline';

// CPU戦：CPUがナビと同じルート探索で展開し、プレイヤーが手札誘発・盤面の妨害で止める練習。
// プレイヤーが後攻ならCPUのターンから、先攻ならプレイヤーが盤面を作ってターンを終えた後にCPUのターンが始まる。
// 止められたらCPUは今の盤面から最適なルートを探し直して動き続ける。CPUのターンが終わると、
// CPUの盤面を相手にしてプレイヤーのターンを続ける。

export type CpuStage = 'thinking' | 'acting' | 'prompt' | 'human' | 'over';

export interface CpuPrompt {
  action: Action;
  step: CpuStep;
  options: HandTrapOption[];
}

export interface CpuDuel {
  cpuDeckName: string;
  stage: CpuStage;
  prompt: CpuPrompt | null;
  /** 直前にCPUが行ったこと */
  last: string;
  /** CPUのターン中（プレイヤーは手札誘発しか使えない） */
  cpuTurn: boolean;
  /** 手札誘発を選ぶ（null は使わない） */
  choose: (option: HandTrapOption | null) => void;
  cpuState: GameState | null;
  /** CPUのゲームで直前に起きたこと（ログ・こちらから見た言い方） */
  recent: string[];
  /** プレイヤーが先攻 */
  humanFirst: boolean;
  /** CPUのターンが終わった */
  cpuDone: boolean;
  /** プレイヤーが先攻のターンにCPUがしたこと（増殖するＧなど） */
  cpuNote: string;
}

const STEP_MS = 900;
const SAVE_KEY = 'ygo-solo:cpu-duel';

/** ページを読み込み直しても続きから再開できるように保存する中身 */
interface Saved {
  /** どのゲーム（自分のデッキ・シード）のCPU戦か */
  sessionKey: string;
  duel: { cpuDeckName: string; seed: number; actions: Action[]; fixedHand?: string[]; humanFirst?: boolean };
  /** CPUのターンが終わった */
  cpuDone?: boolean;
  /** CPUのゲームに写したプレイヤーのカードの目印（変わったら写し直す） */
  humanSig?: string;
  /** プレイヤーが先攻：CPUの手札を相手の手札として写した */
  mirrored?: boolean;
  /** プレイヤーが先攻のターンにCPUが使った増殖するＧなど（名前）と、特殊召喚1回あたりのドロー数 */
  cpuUsed?: string[];
  cpuDrawPer?: number;
  /** プレイヤーのターン中にCPUがしたこと */
  cpuNote?: string;
  stage: CpuStage;
  plan: RouteStep[];
  planIndex: number;
  drawPer: number;
  used: string[];
  last: string;
  humanTurnStart: number | null;
  /** エンドフェイズに除外する自分のモンスター（ＰＳＹフレームギア） */
  banishAtEnd?: string[];
}

function loadSaved(sessionKey: string): Saved | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const saved = raw ? (JSON.parse(raw) as Saved) : null;
    return saved?.sessionKey === sessionKey ? saved : null;
  } catch {
    return null;
  }
}

export function useCpuDuel(opts: {
  ctx: Ctx;
  decks: DeckList[];
  human: GameState;
  dispatchHuman: (a: Action) => boolean;
  onError: (msg: string) => void;
  /** 今のゲーム（自分のデッキ・シード）。保存したCPU戦がこのゲームのものなら続きから再開する */
  sessionKey: string;
  /** メニュー画面などを開いている間は止めておく */
  paused: boolean;
}) {
  const { decks, human, dispatchHuman, onError, sessionKey, paused } = opts;
  // CPUのゲームでは、プレイヤーの妨害は自動で使わない（使うかはプレイヤーが選ぶ）
  const ctx = useMemo(() => ({ ...opts.ctx, options: { ...opts.ctx.options, oppAI: false } }), [opts.ctx]);
  const humanRef = useRef(human);
  humanRef.current = human;
  // 保存した続き（聞いている途中だった手札誘発は、もう一度聞き直す）
  const [saved] = useState(() => loadSaved(sessionKey));
  const [owner, setOwner] = useState(saved?.sessionKey ?? '');
  const [duel, setDuel] = useState<Saved['duel'] | null>(saved?.duel ?? null);
  const [stage, setStage] = useState<CpuStage>(
    saved ? (saved.stage === 'prompt' ? 'acting' : saved.stage) : 'thinking',
  );
  const [plan, setPlan] = useState<RouteStep[]>(saved?.plan ?? []);
  const [planIndex, setPlanIndex] = useState(saved?.planIndex ?? 0);
  const [prompt, setPrompt] = useState<CpuPrompt | null>(null);
  const [drawPer, setDrawPer] = useState(saved?.drawPer ?? 0);
  const [used, setUsed] = useState<string[]>(saved?.used ?? []);
  const [last, setLast] = useState(saved?.last ?? '');
  const [recent, setRecent] = useState<string[]>([]);
  const [humanTurnStart, setHumanTurnStart] = useState<number | null>(saved?.humanTurnStart ?? null);
  const [banishAtEnd, setBanishAtEnd] = useState<string[]>(saved?.banishAtEnd ?? []);
  const [cpuDone, setCpuDone] = useState(saved?.cpuDone ?? false);
  const [humanSig, setHumanSig] = useState(saved?.humanSig ?? '');
  const [mirrored, setMirrored] = useState(saved?.mirrored ?? false);
  const [cpuUsed, setCpuUsed] = useState<string[]>(saved?.cpuUsed ?? []);
  const [cpuDrawPer, setCpuDrawPer] = useState(saved?.cpuDrawPer ?? 0);
  const [cpuNote, setCpuNote] = useState(saved?.cpuNote ?? '');
  const workerRef = useRef<Worker | null>(null);

  // 進むたびに保存する（CPU戦をやめたら消す）
  useEffect(() => {
    try {
      if (!duel) localStorage.removeItem(SAVE_KEY);
      else {
        const data: Saved = {
          sessionKey: owner,
          duel,
          stage,
          plan,
          planIndex,
          drawPer,
          used,
          last,
          humanTurnStart,
          banishAtEnd,
          cpuDone,
          humanSig,
          mirrored,
          cpuUsed,
          cpuDrawPer,
          cpuNote,
        };
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      }
    } catch {
      // 保存できない環境では何もしない
    }
  }, [
    owner,
    duel,
    stage,
    plan,
    planIndex,
    drawPer,
    used,
    last,
    humanTurnStart,
    banishAtEnd,
    cpuDone,
    humanSig,
    mirrored,
    cpuUsed,
    cpuDrawPer,
    cpuNote,
  ]);

  const cpuState = useMemo(() => {
    if (!duel) return null;
    const deck = decks.find((d) => d.name === duel.cpuDeckName);
    if (!deck) return null;
    try {
      // CPUが後攻でも初手は5枚（プレイヤーのターンを「CPUのゲームの1ターン目」とし、CPUのターンの初めにドロー）
      const init = createGame(deck, ctx, duel.seed, duel.fixedHand ?? []);
      return replay(init, duel.actions, ctx);
    } catch {
      return null;
    }
  }, [duel, decks, ctx]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  /** humanFirst：プレイヤーが先攻（盤面を作ってターンを終えたらCPUのターン） */
  const start = useCallback((cpuDeckName: string, seed: number, key: string, humanFirst: boolean) => {
    workerRef.current?.terminate();
    setOwner(key);
    setDuel({ cpuDeckName, seed, actions: [], humanFirst });
    setStage(humanFirst ? 'human' : 'thinking');
    setCpuDone(false);
    setHumanSig('');
    setMirrored(false);
    setCpuUsed([]);
    setCpuDrawPer(0);
    setCpuNote('');
    setPlan([]);
    setPlanIndex(0);
    setPrompt(null);
    setDrawPer(0);
    setUsed([]);
    setLast('');
    setHumanTurnStart(null);
    setBanishAtEnd([]);
  }, []);

  const stop = useCallback(() => {
    workerRef.current?.terminate();
    setDuel(null);
    setPrompt(null);
  }, []);

  /** CPUのゲームに操作を行い、相手の盤面として写す */
  const applyCpu = useCallback(
    (actions: Action[], text?: string, keep: string[] = []): GameState | null => {
      if (!duel || !cpuState) return null;
      let s = cpuState;
      for (const a of actions) {
        const r = applyAction(s, a, ctx);
        if (!r.ok) {
          onError(`CPUの操作に失敗しました：${r.error}`);
          return null;
        }
        // 増殖するＧなど：CPUが特殊召喚するたびにドロー
        const ss = specialSummonsBetween(s, r.state);
        if (ss && drawPer) dispatchHuman({ type: 'DRAW', count: ss * drawPer });
        s = r.state;
      }
      setDuel({ ...duel, actions: [...duel.actions, ...actions] });
      dispatchHuman(syncAction(s));
      // CPUのゲームで動いたプレイヤーのカード（破壊された・妨害に使ったなど）をこちらにも反映する
      reverseSync(s, humanRef.current, keep).forEach((a) => dispatchHuman(a));
      if (text) setLast(text);
      // CPUのゲームのログを、こちらから見た言い方にして見せる（手札誘発を置いた・墓地へ送った内部の処理は省く）
      setRecent(
        s.log
          .slice(cpuState.log.length)
          .map((l) => l.text)
          .filter((t) => !t.startsWith('（練習）') && !t.includes('相手の手札から相手の墓地へ'))
          .map((t) => t.replace(/相手の/g, 'あなたの'))
          .slice(-8),
      );
      return s;
    },
    [duel, cpuState, ctx, drawPer, dispatchHuman, onError],
  );

  const endCpuTurn = useCallback(() => {
    if (cpuState) {
      dispatchHuman(syncAction(cpuState));
      reverseSync(cpuState, humanRef.current).forEach((a) => dispatchHuman(a));
    }
    // ＰＳＹフレームギアの効果で特殊召喚したモンスターはエンドフェイズに除外される
    for (const u of banishAtEnd)
      if (human.mz.includes(u))
        dispatchHuman({
          type: 'MOVE',
          uid: u,
          to: { zone: 'banished' },
          reason: 'エンドフェイズに除外（ＰＳＹフレームギア）',
        });
    setBanishAtEnd([]);
    dispatchHuman({ type: 'END_TURN' });
    setLast('CPUはターンを終了した');
    setCpuDone(true);
    setHumanTurnStart(null);
    setStage('human');
  }, [cpuState, dispatchHuman, banishAtEnd, human.mz]);

  // ルートを考える（初回・止められた後）
  useEffect(() => {
    if (!duel || stage !== 'thinking' || !cpuState || paused) return;
    let worker: Worker;
    try {
      worker = new SolverWorker();
    } catch {
      onError('この環境ではCPUを動かせませんでした');
      return;
    }
    workerRef.current?.terminate();
    workerRef.current = worker;
    worker.onmessage = (e) => {
      if (e.data.type !== 'done') return;
      worker.terminate();
      const best: { steps: RouteStep[] } | undefined = e.data.routes[0];
      if (!best || !best.steps.length) {
        endCpuTurn();
        return;
      }
      setPlan(best.steps);
      setPlanIndex(0);
      setStage('acting');
    };
    worker.onerror = () => {
      onError('CPUのルート探索でエラーが起きました');
      endCpuTurn();
    };
    worker.postMessage({ state: cpuState, deckName: duel.cpuDeckName, maxNodes: 1500, noOppAI: true });
    return () => worker.terminate();
    // 考え始めた盤面で探す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, duel?.cpuDeckName, duel?.seed, paused]);

  // 1手ずつ動く。プレイヤーが手札誘発を使えるなら止まって聞く
  useEffect(() => {
    if (!duel || stage !== 'acting' || !cpuState || paused) return;
    const t = setTimeout(() => {
      // プレイヤーのカードが変わっていたら、CPUのゲームに写し直す
      const sig = humanSignature(human);
      if (sig !== humanSig) {
        if (applyCpu([syncAction(human)])) setHumanSig(sig);
        return;
      }
      if (planIndex >= plan.length) return endCpuTurn();
      const action = plan[planIndex].action;
      if (!applyAction(cpuState, action, ctx).ok) {
        // 盤面が予定と変わった：探し直す
        setStage('thinking');
        return;
      }
      const options = handTrapOptions(cpuState, human, ctx, action, used);
      const step = describeCpuStep(cpuState, ctx, action);
      if (options.length) {
        setPrompt({ action, step, options });
        setStage('prompt');
        return;
      }
      if (applyCpu([action], step.text)) setPlanIndex(planIndex + 1);
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [duel, stage, cpuState, plan, planIndex, human, ctx, used, applyCpu, endCpuTurn, paused, humanSig]);

  // プレイヤーが先攻：プレイヤーがターンを終えたら、プレイヤーの盤面を写してCPUのターンを始める
  useEffect(() => {
    if (!duel?.humanFirst || cpuDone || stage !== 'human' || !human.opponentTurn || !cpuState || paused) return;
    // プレイヤーのカードを写し、CPUのターン（ドローフェイズで1枚ドロー）→ メインフェイズ1
    // （エンドフェイズに除外されたＰＳＹフレームギアなど、CPUのカードの動きを先に戻す）
    const actions: Action[] = [
      ...reverseSync(human, cpuState),
      syncAction(human),
      { type: 'END_TURN', startOwnTurn: true },
      { type: 'NEXT_PHASE', to: 'M1' },
    ];
    if (applyCpu(actions, 'CPUのターン（後攻）が始まった')) {
      setHumanSig(humanSignature(human));
      setStage('thinking');
    }
  }, [duel?.humanFirst, cpuDone, stage, human, cpuState, paused, applyCpu]);

  // プレイヤーが先攻のターン：CPUの手札を相手の手札として写す（手札誘発は相手のAIが自動でチェーンしてくる）
  const firstTurn = !!duel?.humanFirst && !cpuDone && stage === 'human' && !human.opponentTurn && !paused;
  useEffect(() => {
    if (!firstTurn || mirrored || !cpuState) return;
    dispatchHuman(syncAction(cpuState));
    setMirrored(true);
  }, [firstTurn, mirrored, cpuState, dispatchHuman]);

  // プレイヤーが先攻のターン：CPUが使った手札誘発（相手の盤面で墓地へ送られたカード）をCPUのゲームに戻し、
  // 増殖するＧ・ドロール＆ロックバードを使う
  const prevHuman = useRef(human);
  useEffect(() => {
    const prev = prevHuman.current;
    prevHuman.current = human;
    if (!firstTurn || !mirrored || !cpuState) return;
    const back = reverseSync(human, cpuState);
    if (back.length) {
      applyCpu(back);
      return;
    }
    const nameOf = (u: string) => getDef(cpuState, ctx, u).name;
    const oppCopy = (u: string) => Object.values(human.cards).find((c) => c.opp && c.syncKey === u)?.uid;
    // 増殖するＧ・マルチャミー・フワロス：プレイヤーが効果を発動し始めたら使う
    const g = cpuState.hand.find(
      (u) => ['増殖するＧ', 'マルチャミー・フワロス'].includes(nameOf(u)) && !cpuUsed.includes(nameOf(u)),
    );
    if (g && human.chain.some((l) => !l.opp) && oppCopy(g)) {
      dispatchHuman({ type: 'MOVE', uid: oppCopy(g)!, to: { zone: 'gy' }, reason: `CPUが${nameOf(g)}を発動` });
      setCpuUsed((x) => [...x, nameOf(g)]);
      setCpuDrawPer((n) => n + 1);
      setCpuNote(`CPUは${nameOf(g)}を発動した（あなたが特殊召喚するたびにCPUが1枚ドロー）`);
      return;
    }
    const ss = specialSummonsBetween(prev, human);
    if (ss && cpuDrawPer) {
      applyCpu([{ type: 'DRAW', count: ss * cpuDrawPer }]);
      setCpuNote(
        `CPUは増殖するＧなどの効果で${ss * cpuDrawPer}枚ドローした（CPUの手札${cpuState.hand.length + ss * cpuDrawPer}枚）`,
      );
      return;
    }
    // ドロール＆ロックバード：プレイヤーがドロー以外でデッキから手札に加えた後に使う
    const droll = cpuState.hand.find(
      (u) => nameOf(u) === 'ドロール＆ロックバード' && !cpuUsed.includes('ドロール＆ロックバード'),
    );
    if (
      droll &&
      oppCopy(droll) &&
      !human.chain.length &&
      human.deckToHandTurn === human.turn &&
      human.noDeckToHandTurn !== human.turn
    ) {
      dispatchHuman({
        type: 'MOVE',
        uid: oppCopy(droll)!,
        to: { zone: 'gy' },
        reason: 'CPUがドロール＆ロックバードを発動',
      });
      dispatchHuman({ type: 'NO_DECK_TO_HAND', by: 'CPUのドロール＆ロックバード' });
      setCpuUsed((x) => [...x, 'ドロール＆ロックバード']);
      setCpuNote('CPUはドロール＆ロックバードを発動した（このターン、デッキからカードを手札に加えられない）');
    }
    // 変わったプレイヤーの盤面にだけ反応する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [human, firstTurn, mirrored]);

  // CPUのターンの後のプレイヤーのターンが終わったら、CPU戦はおしまい
  useEffect(() => {
    if (!duel || stage !== 'human' || !cpuDone) return;
    if (humanTurnStart === null) setHumanTurnStart(human.turn);
    else if (human.turn > humanTurnStart || human.status !== 'playing') setStage('over');
  }, [duel, stage, human.turn, human.status, humanTurnStart]);

  const choose = useCallback(
    (option: HandTrapOption | null) => {
      if (!prompt || !cpuState) return;
      const { action, step } = prompt;
      setPrompt(null);
      if (!option) {
        if (applyCpu([action], step.text)) setPlanIndex(planIndex + 1);
        setStage('acting');
        return;
      }
      const res = applyHandTrap(cpuState, ctx, action, option, human);
      if (!res) {
        onError(`${option.name}を使えませんでした`);
        setStage('acting');
        return;
      }
      res.humanActions.forEach((a) => dispatchHuman(a));
      if (res.banishAtEnd) setBanishAtEnd((b) => [...b, ...res.banishAtEnd!]);
      setUsed((u) => [...u, option.name]);
      if (option.kind === 'draw') {
        setDrawPer((n) => n + 1);
        setLast(`あなたは${option.name}を発動した`);
        // 増殖するＧは効果を止めないので、CPUは予定通り動く（このドローは次の操作から）
        setStage('acting');
        return;
      }
      applyCpu(res.cpuActions, `あなたの${option.name}で「${step.text}」を止めた`, res.keep);
      setStage('thinking');
    },
    [prompt, cpuState, ctx, human, applyCpu, planIndex, dispatchHuman, onError],
  );

  const active = !!duel;
  const cpuTurn = active && (stage === 'thinking' || stage === 'acting' || stage === 'prompt');
  const value: CpuDuel | null = duel
    ? {
        cpuDeckName: duel.cpuDeckName,
        stage,
        prompt,
        last,
        cpuTurn,
        choose,
        cpuState,
        recent,
        humanFirst: !!duel.humanFirst,
        cpuDone,
        cpuNote,
      }
    : null;
  return { duel: value, start, stop };
}
