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

export function useCpuDuel(opts: {
  ctx: Ctx;
  decks: DeckList[];
  human: GameState;
  dispatchHuman: (a: Action) => boolean;
  onError: (msg: string) => void;
}) {
  const { ctx, decks, human, dispatchHuman, onError } = opts;
  const [duel, setDuel] = useState<{ cpuDeckName: string; seed: number; actions: Action[] } | null>(null);
  const [stage, setStage] = useState<CpuStage>('thinking');
  const [plan, setPlan] = useState<RouteStep[]>([]);
  const [planIndex, setPlanIndex] = useState(0);
  const [prompt, setPrompt] = useState<CpuPrompt | null>(null);
  const [drawPer, setDrawPer] = useState(0);
  const [used, setUsed] = useState<string[]>([]);
  const [last, setLast] = useState('');
  const workerRef = useRef<Worker | null>(null);
  const humanTurnStart = useRef<number | null>(null);

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

  const start = useCallback((cpuDeckName: string, seed: number) => {
    workerRef.current?.terminate();
    setDuel({ cpuDeckName, seed, actions: [] });
    setStage('thinking');
    setPlan([]);
    setPlanIndex(0);
    setPrompt(null);
    setDrawPer(0);
    setUsed([]);
    setLast('');
    humanTurnStart.current = null;
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
    dispatchHuman({ type: 'END_TURN' });
    setLast('CPUはターンを終了した');
    setStage('human');
  }, [cpuState, dispatchHuman]);

  // ルートを考える（初回・止められた後）
  useEffect(() => {
    if (!duel || stage !== 'thinking' || !cpuState) return;
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
  }, [stage, duel?.cpuDeckName, duel?.seed]);

  // 1手ずつ動く。プレイヤーが手札誘発を使えるなら止まって聞く
  useEffect(() => {
    if (!duel || stage !== 'acting' || !cpuState) return;
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
  }, [duel, stage, cpuState, plan, planIndex, human, ctx, used, applyCpu, endCpuTurn]);

  // プレイヤーのターンが終わったら、CPU戦はおしまい
  useEffect(() => {
    if (!duel || stage !== 'human') return;
    if (humanTurnStart.current === null) humanTurnStart.current = human.turn;
    else if (human.turn > humanTurnStart.current || human.status !== 'playing') setStage('over');
  }, [duel, stage, human.turn, human.status]);

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
      const res = applyHandTrap(cpuState, ctx, action, option, human.cards[option.uid].defId);
      if (!res) {
        onError(`${option.name}を使えませんでした`);
        setStage('acting');
        return;
      }
      res.humanActions.forEach((a) => dispatchHuman(a));
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
