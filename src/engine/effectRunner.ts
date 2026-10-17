import { type Action, applyAction, candidates, type Ctx, findLocation, makeEnv } from './game';
import type { EffectDef, Step } from './scripts';
import type { GameState, Location } from './types';

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
  /**
   * チェーンの扱い。auto：コストを払った後、チェーンできる効果があればチェーンに積んで止める／
   * force：必ず積む／never：最後まで処理する
   */
  chainMode: 'auto' | 'force' | 'never';
  /** チェーンを解決している */
  resolving: boolean;
}

export type RunResult =
  | { kind: 'running'; run: Running }
  | { kind: 'done'; action: Action }
  | { kind: 'error'; error: string };

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

/** 効果のスペルスピード */
export function effectSpeed(state: GameState, ctx: Ctx, uid: string, effect: EffectDef): number {
  if (effect.speed) return effect.speed;
  if (effect.isCardActivation) {
    const def = makeEnv(state, ctx, uid).def(uid);
    if (def.trapType === 'counter') return 3;
    if (def.kind === 'trap' || def.spellType === 'quick') return 2;
  }
  return 1;
}

function effectKey(uid: string, effect: EffectDef): string | undefined {
  return effect.key ? (effect.perCard ? `${effect.key}:${uid}` : effect.key) : undefined;
}

/** 今のチェーンに続けて発動できる効果（スペルスピード2以上・使用回数が残っている） */
export function chainableEffects(state: GameState, ctx: Ctx, minSpeed: number): { uid: string; effect: EffectDef }[] {
  const out: { uid: string; effect: EffectDef }[] = [];
  const env = makeEnv(state, ctx, '');
  const uids = [
    ...state.hand,
    ...state.mz,
    ...state.emz,
    ...state.stz,
    state.fz,
    ...state.gy,
  ].filter((u): u is string => !!u);
  for (const uid of uids) {
    for (const effect of ctx.scripts?.[env.def(uid).id]?.effects ?? []) {
      if (effect.opponentOnly || !effectAvailable(state, uid, effect)) continue;
      const speed = effectSpeed(state, ctx, uid, effect);
      if (speed < 2 || speed < minSpeed) continue;
      const key = effectKey(uid, effect);
      if (key && effect.limit !== undefined && (state.effectUses[key] ?? 0) >= effect.limit) continue;
      if (effect.isCardActivation && env.def(uid).oncePerTurnActivation && state.effectUses[`${env.def(uid).name}:発動`]) continue;
      if (effect.condition?.(makeEnv(state, ctx, uid))) continue;
      // 罠はセットしたターンには発動できない
      if (effect.isCardActivation && env.def(uid).kind === 'trap' && state.cards[uid].enteredTurn === state.turn) continue;
      out.push({ uid, effect });
    }
  }
  return out;
}

export function startEffect(
  state: GameState,
  ctx: Ctx,
  uid: string,
  effect: EffectDef,
  /** 魔法・罠を手札から発動するときに置くゾーン */
  activationZone?: Location,
  chainMode: Running['chainMode'] = 'never',
): RunResult {
  const env = makeEnv(state, ctx, uid);
  const cond = effect.condition?.(env);
  if (cond) return { kind: 'error', error: cond };
  const key = effectKey(uid, effect);
  const first: Action = effect.isCardActivation
    ? { type: 'ACTIVATE_CARD', uid, index: activationZone?.zone === 'stz' ? activationZone.index : undefined }
    : { type: 'ACTIVATE_EFFECT', uid, label: effect.label, key, limit: effect.limit };
  const batch: Action[] = [first];
  if (effect.onSummon) {
    const inst = state.cards[uid];
    if (inst.enteredTurn !== state.turn)
      return { kind: 'error', error: 'このターンに召喚・特殊召喚されたカードではありません' };
    // 召喚1回につき1度だけ（ターン1の制限とは別に管理）
    batch.push({
      type: 'ACTIVATE_EFFECT',
      uid,
      silent: true,
      key: `召喚時:${effect.label}:${uid}:${inst.entryId}`,
      limit: 1,
    });
  }
  let r = applyAction(state, first, ctx);
  if (r.ok && batch.length > 1) r = applyAction(r.state, batch[1], ctx);
  if (!r.ok) return { kind: 'error', error: r.error };
  return advance(
    {
      title: `${env.def(uid).name}：${effect.label}`,
      self: uid,
      effect,
      stepIndex: 0,
      temp: r.state,
      batch,
      stage: 'pick',
      picked: [],
      mode: 0,
      chainMode: state.chain?.length ? 'force' : chainMode,
      resolving: false,
    },
    ctx,
  );
}

/** チェーンの一番上の効果を解決する */
export function startResolve(state: GameState, ctx: Ctx): RunResult {
  const link = state.chain[state.chain.length - 1];
  if (!link) return { kind: 'error', error: '解決するチェーンがありません' };
  const effect = ctx.scripts?.[link.defId]?.effects?.[link.effect];
  if (!effect) return { kind: 'error', error: '効果が見つかりません' };
  const name = makeEnv(state, ctx, link.uid).def(link.uid).name;
  return advance(
    {
      title: `チェーン${state.chain.length}を解決：${name}`,
      self: link.uid,
      effect,
      stepIndex: link.stepStart,
      temp: state,
      batch: [],
      stage: 'pick',
      picked: [],
      mode: 0,
      chainMode: 'never',
      resolving: true,
    },
    ctx,
  );
}

/** コストを払い終えたところでチェーンに積むか決める */
function pushToChain(run: Running, ctx: Ctx): RunResult | null {
  if (run.chainMode === 'never' || run.resolving) return null;
  const speed = effectSpeed(run.temp, ctx, run.self, run.effect);
  const responses = chainableEffects(run.temp, ctx, Math.max(2, speed)).filter((c) => c.uid !== run.self);
  if (run.chainMode === 'auto' && responses.length === 0) return null;
  const def = makeEnv(run.temp, ctx, run.self).def(run.self);
  const index = ctx.scripts?.[def.id]?.effects?.indexOf(run.effect) ?? -1;
  if (index < 0) return null;
  const push: Action = {
    type: 'CHAIN_PUSH',
    uid: run.self,
    effect: index,
    stepStart: run.stepIndex,
    speed,
    label: run.effect.label,
  };
  const r = applyAction(run.temp, push, ctx);
  if (!r.ok) return { kind: 'error', error: r.error };
  return { kind: 'done', action: { type: 'BATCH', label: run.title, actions: [...run.batch, push] } };
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
    // コストを払い終えたら、チェーンに積むか（積まずにこのまま処理するか）を決める
    if (cur.chainMode !== 'never' && !cur.resolving && (!step || !step.cost)) {
      const pushed = pushToChain(cur, ctx);
      if (pushed) return pushed;
      cur = { ...cur, chainMode: 'never' };
    }
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
  const actions = run.resolving ? [...cur.batch, { type: 'CHAIN_POP' } as Action] : cur.batch;
  return { kind: 'done', action: { type: 'BATCH', label: run.title, actions } };
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
