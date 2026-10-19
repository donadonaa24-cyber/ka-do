import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CpuStep,
  describeCpuStep,
  type HandTrapOption,
  handTrapOptions,
  specialSummonsBetween,
  syncAction,
  applyHandTrap,
} from '../engine/cpu';
import { type Action, applyAction, createGame, type Ctx, replay } from '../engine/game';
import type { RouteStep } from '../engine/solver';
import type { DeckList, GameState } from '../engine/types';
import SolverWorker from './solver.worker?worker&inline';

// CPU戦：CPU（先攻）がナビと同じルート探索で展開し、プレイヤー（後攻）が手札誘発で止める練習。
// 止められたらCPUは今の盤面から最適なルートを探し直して動き続ける。CPUのターンが終わると、
// CPUの盤面（妨害・手札誘発）を相手にしてプレイヤーのターンを続ける。

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
}

const STEP_MS = 900;
const SAVE_KEY = 'ygo-solo:cpu-duel';

/** ページを読み込み直しても続きから再開できるように保存する中身 */
interface Saved {
  /** どのゲーム（自分のデッキ・シード）のCPU戦か */
  sessionKey: string;
  duel: { cpuDeckName: string; seed: number; actions: Action[] };
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
  const { ctx, decks, human, dispatchHuman, onError, sessionKey, paused } = opts;
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
  const [humanTurnStart, setHumanTurnStart] = useState<number | null>(saved?.humanTurnStart ?? null);
  const [banishAtEnd, setBanishAtEnd] = useState<string[]>(saved?.banishAtEnd ?? []);
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
        };
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      }
    } catch {
      // 保存できない環境では何もしない
    }
  }, [owner, duel, stage, plan, planIndex, drawPer, used, last, humanTurnStart, banishAtEnd]);

  const cpuState = useMemo(() => {
    if (!duel) return null;
    const deck = decks.find((d) => d.name === duel.cpuDeckName);
    if (!deck) return null;
    try {
      return replay(createGame(deck, ctx, duel.seed), duel.actions, ctx);
    } catch {
      return null;
    }
  }, [duel, decks, ctx]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const start = useCallback((cpuDeckName: string, seed: number, key: string) => {
    workerRef.current?.terminate();
    setOwner(key);
    setDuel({ cpuDeckName, seed, actions: [] });
    setStage('thinking');
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
    (actions: Action[], text?: string): GameState | null => {
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
      if (text) setLast(text);
      return s;
    },
    [duel, cpuState, ctx, drawPer, dispatchHuman, onError],
  );

  const endCpuTurn = useCallback(() => {
    if (cpuState) dispatchHuman(syncAction(cpuState));
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
    worker.postMessage({ state: cpuState, deckName: duel.cpuDeckName, maxNodes: 1500 });
    return () => worker.terminate();
    // 考え始めた盤面で探す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, duel?.cpuDeckName, duel?.seed, paused]);

  // 1手ずつ動く。プレイヤーが手札誘発を使えるなら止まって聞く
  useEffect(() => {
    if (!duel || stage !== 'acting' || !cpuState || paused) return;
    const t = setTimeout(() => {
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
  }, [duel, stage, cpuState, plan, planIndex, human, ctx, used, applyCpu, endCpuTurn, paused]);

  // プレイヤーのターンが終わったら、CPU戦はおしまい
  useEffect(() => {
    if (!duel || stage !== 'human') return;
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
      applyCpu(res.cpuActions, `あなたの${option.name}で「${step.text}」を止めた`);
      setStage('thinking');
    },
    [prompt, cpuState, ctx, human, applyCpu, planIndex, dispatchHuman, onError],
  );

  const active = !!duel;
  const cpuTurn = active && (stage === 'thinking' || stage === 'acting' || stage === 'prompt');
  const value: CpuDuel | null = duel
    ? { cpuDeckName: duel.cpuDeckName, stage, prompt, last, cpuTurn, choose, cpuState }
    : null;
  return { duel: value, start, stop };
}
