import { type Action, applyAction, candidates, type Ctx, findLocation, makeEnv } from '../engine/game';
import type { EffectDef, Step } from '../engine/scripts';
import type { GameState, Location } from '../engine/types';

/** 実行中の効果処理。途中の盤面（temp）を見ながら1ステップずつ選ばせる */
export interface Running {
  title: string;
  self: string;
  effect: EffectDef;
  stepIndex: number;
  temp: GameState;
  batch: Action[];
  stage: 'pick' | 'mode' | 'zone';
  picked: string[];
  mode: number;
}

export type RunResult = { kind: 'running'; run: Running } | { kind: 'done'; action: Action } | { kind: 'error'; error: string };

type EffectFrom = EffectDef['from'][number];

export function effectLocation(state: GameState, uid: string): EffectFrom | null {
  const loc = findLocation(state, uid);
  if (!loc) return null;
  switch (loc.zone) {
    case 'hand':
      return 'hand';
    case 'mz':
    case 'emz':
      return 'monster';
    case 'stz':
      return 'spelltrap';
    case 'fz':
      return 'field-zone';
    case 'gy':
      return 'gy';
    case 'banished':
      return 'banished';
    default:
      return null;
  }
}

/** このカードの今の場所から使える効果か */
export function effectAvailable(state: GameState, uid: string, effect: EffectDef): boolean {
  const where = effectLocation(state, uid);
  if (!where || !effect.from.includes(where)) return false;
  const onField = where === 'monster' || where === 'spelltrap' || where === 'field-zone';
  if (effect.isCardActivation && onField) return !state.cards[uid].faceUp;
  if (!effect.isCardActivation && (where === 'spelltrap' || where === 'field-zone')) return state.cards[uid].faceUp;
  return true;
}

export function startEffect(state: GameState, ctx: Ctx, uid: string, effect: EffectDef): RunResult {
  const env = makeEnv(state, ctx, uid);
  const cond = effect.condition?.(env);
  if (cond) return { kind: 'error', error: cond };
  const key = effect.key ? (effect.perCard ? `${effect.key}:${uid}` : effect.key) : undefined;
  const first: Action = effect.isCardActivation
    ? { type: 'ACTIVATE_CARD', uid }
    : { type: 'ACTIVATE_EFFECT', uid, label: effect.label, key, limit: effect.limit };
  const r = applyAction(state, first, ctx);
  if (!r.ok) return { kind: 'error', error: r.error };
  return advance(
    {
      title: `${env.def(uid).name}：${effect.label}`,
      self: uid,
      effect,
      stepIndex: 0,
      temp: r.state,
      batch: [first],
      stage: 'pick',
      picked: [],
      mode: 0,
    },
    ctx,
  );
}

function applyAll(run: Running, ctx: Ctx, actions: Action[]): Running | string {
  let temp = run.temp;
  for (const a of actions) {
    const r = applyAction(temp, a, ctx);
    if (!r.ok) return r.error;
    temp = r.state;
  }
  return { ...run, temp, batch: [...run.batch, ...actions] };
}

export function currentStep(run: Running): Step | undefined {
  return run.effect.steps[run.stepIndex];
}

export function pickRange(run: Running, ctx: Ctx): [number, number] {
  const step = currentStep(run);
  if (!step || step.op !== 'pick') return [0, 0];
  if (step.count) {
    const n = step.count(makeEnv(run.temp, ctx, run.self));
    return [n, n];
  }
  return [step.min ?? 1, step.max ?? 1];
}

export function stepCandidates(run: Running, ctx: Ctx): string[] {
  const step = currentStep(run);
  if (!step || step.op !== 'pick') return [];
  const env = makeEnv(run.temp, ctx, run.self);
  return candidates(run.temp, step.from).filter(
    (u) => (!step.filter || env.matches(u, step.filter)) && (!step.where || step.where(env, u)),
  );
}

/** 選択不要なステップを進め、選択が必要なところで止まる */
export function advance(run: Running, ctx: Ctx): RunResult {
  let cur = run;
  for (;;) {
    const step = currentStep(cur);
    if (!step) return finish(cur, ctx);
    if (step.op === 'do') {
      const next = applyAll(cur, ctx, step.then(makeEnv(cur.temp, ctx, cur.self)));
      if (typeof next === 'string') return { kind: 'error', error: next };
      cur = { ...next, stepIndex: cur.stepIndex + 1 };
      continue;
    }
    if (step.op === 'place') return { kind: 'running', run: { ...cur, stage: 'zone', picked: [] } };
    const [min] = pickRange(cur, ctx);
    const cands = stepCandidates(cur, ctx);
    if (cands.length === 0) {
      if (min > 0) return { kind: 'error', error: `選べるカードがありません（${step.prompt}）` };
      cur = { ...cur, stepIndex: cur.stepIndex + 1 };
      continue;
    }
    return { kind: 'running', run: { ...cur, stage: 'pick', picked: [], mode: 0 } };
  }
}

function finish(run: Running, ctx: Ctx): RunResult {
  let cur = run;
  // 発動した魔法・罠は効果処理の後に墓地へ
  if (run.effect.isCardActivation && cur.temp.cards[run.self]?.pendingResolve) {
    const next = applyAll(cur, ctx, [{ type: 'RESOLVE', uid: run.self }]);
    if (typeof next === 'string') return { kind: 'error', error: next };
    cur = next;
  }
  return { kind: 'done', action: { type: 'BATCH', label: run.title, actions: cur.batch } };
}

/** 選択（カード・処理の種類・ゾーン）を確定して次へ */
export function completeStep(run: Running, ctx: Ctx, zone: Location | null): RunResult {
  const step = currentStep(run)!;
  const env = makeEnv(run.temp, ctx, run.self);
  let actions: Action[];
  if (step.op === 'place') actions = step.then(env, zone!);
  else if (step.op === 'pick') actions = step.then(env, run.picked, zone, run.mode);
  else actions = [];
  const next = applyAll(run, ctx, actions);
  if (typeof next === 'string') return { kind: 'error', error: next };
  return advance({ ...next, stepIndex: run.stepIndex + 1 }, ctx);
}

/** カード選択の後に必要な段階（処理の種類 → ゾーン）へ進む。不要なら確定する */
export function afterPick(run: Running, ctx: Ctx): RunResult {
  const step = currentStep(run);
  if (step?.op !== 'pick') return { kind: 'running', run };
  if (run.picked.length === 0) return completeStep(run, ctx, null);
  if (step.modes && run.stage === 'pick') return { kind: 'running', run: { ...run, stage: 'mode' } };
  if (step.zone) return { kind: 'running', run: { ...run, stage: 'zone' } };
  return completeStep(run, ctx, null);
}

export function runZoneKind(run: Running): 'monster' | 'stz' | null {
  const step = currentStep(run);
  if (run.stage !== 'zone' || !step) return null;
  if (step.op === 'place') return step.zone;
  if (step.op === 'pick') return step.zone ?? null;
  return null;
}
