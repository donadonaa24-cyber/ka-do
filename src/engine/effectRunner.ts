import { type Action, applyAction, candidates, type Ctx, findLocation, isMonsterZone, makeEnv } from './game';
import type { EffectDef, Env, Step } from './scripts';
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
  /** 効果のステップとは別に、今選ばせているステップ（「処理後まで除外」など） */
  extraStep?: Step;
  /** 処理の前の「処理後まで除外」を確認済み */
  tempBanishChecked?: boolean;
  /** 処理後まで除外したモンスター（処理が終わったら戻す） */
  tempBanished?: { uid: string; index: number; position: 'atk' | 'def' };
  /** これまでのステップで選んだカード（後のステップの条件に使う） */
  history?: string[][];
}

/** ステップに渡す盤面の見え方（前のステップで選んだカードを含む） */
function stepEnv(run: Running, ctx: Ctx): Env {
  return { ...makeEnv(run.temp, ctx, run.self), picks: run.history ?? [] };
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

/**
 * ターン制限の管理キー。カード名の付かない「1ターンに1度」（perCard）は、
 * フィールドを離れて戻ると別のカードとして扱うので entryId も含める
 */
function effectKey(state: GameState, uid: string, effect: EffectDef): string | undefined {
  if (!effect.key) return undefined;
  return effect.perCard ? `${effect.key}:${uid}:${state.cards[uid]?.entryId ?? 0}` : effect.key;
}

function nameLimitReached(state: GameState, effect: EffectDef): boolean {
  return !!effect.key && effect.nameLimit !== undefined && (state.effectUses[effect.key] ?? 0) >= effect.nameLimit;
}

/** 今のチェーンに続けて発動できる効果（スペルスピード2以上・使用回数が残っている） */
export function chainableEffects(state: GameState, ctx: Ctx, minSpeed: number): { uid: string; effect: EffectDef }[] {
  const out: { uid: string; effect: EffectDef }[] = [];
  const env = makeEnv(state, ctx, '');
  const uids = [...state.hand, ...state.mz, ...state.emz, ...state.stz, state.fz, ...state.gy].filter(
    (u): u is string => !!u,
  );
  for (const uid of uids) {
    for (const effect of ctx.scripts?.[env.def(uid).id]?.effects ?? []) {
      if (effect.opponentOnly || !effectAvailable(state, uid, effect)) continue;
      const speed = effectSpeed(state, ctx, uid, effect);
      if (speed < 2 || speed < minSpeed) continue;
      const key = effectKey(state, uid, effect);
      if (key && effect.limit !== undefined && (state.effectUses[key] ?? 0) >= effect.limit) continue;
      if (nameLimitReached(state, effect)) continue;
      if (
        effect.isCardActivation &&
        env.def(uid).oncePerTurnActivation &&
        state.effectUses[`${env.def(uid).name}:発動`]
      )
        continue;
      if (effect.condition?.(makeEnv(state, ctx, uid))) continue;
      // 罠はセットしたターンには発動できない
      if (effect.isCardActivation && env.def(uid).kind === 'trap' && state.cards[uid].enteredTurn === state.turn)
        continue;
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
  // 相手ターンに使えるのは速攻効果（スペルスピード2以上）と誘発効果だけ
  if (
    ctx.options.strict &&
    state.opponentTurn &&
    effectSpeed(state, ctx, uid, effect) < 2 &&
    !effect.trigger &&
    !effect.onSummon
  )
    return { kind: 'error', error: 'この効果は相手ターンには発動できません' };
  const cond = effect.condition?.(env);
  if (cond) return { kind: 'error', error: cond };
  const key = effectKey(state, uid, effect);
  const first: Action = effect.isCardActivation
    ? { type: 'ACTIVATE_CARD', uid, index: activationZone?.zone === 'stz' ? activationZone.index : undefined }
    : { type: 'ACTIVATE_EFFECT', uid, label: effect.label, key, limit: effect.limit };
  const batch: Action[] = [first];
  // 魔法・罠の発動そのものに「このカード名の効果は1ターンに1度」がある場合
  if (effect.isCardActivation && key) {
    if (effect.limit !== undefined && (state.effectUses[key] ?? 0) >= effect.limit)
      return { kind: 'error', error: `このカード名の効果は1ターンに${effect.limit}度までです` };
    batch.push({ type: 'ACTIVATE_EFFECT', uid, silent: true, key, limit: effect.limit });
  }
  if (effect.key && effect.nameLimit !== undefined) {
    if (nameLimitReached(state, effect))
      return { kind: 'error', error: `このカード名の効果は1ターンに${effect.nameLimit}度までです` };
    batch.push({ type: 'ACTIVATE_EFFECT', uid, silent: true, key: effect.key, limit: effect.nameLimit });
  }
  if (effect.onSummon) {
    const inst = state.cards[uid];
    if (inst.enteredTurn !== state.turn || inst.summonedEntry !== inst.entryId)
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
  for (const a of batch.slice(1)) if (r.ok) r = applyAction(r.state, a, ctx);
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
  if (run.chainMode === 'never' || run.resolving || run.effect.applied) return null;
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
  return run.extraStep ?? run.effect.steps[run.stepIndex];
}

/**
 * 「他のカードが発動した効果が処理される際に、モンスターを処理後まで除外できる」効果（完全なる世界③）を
 * 使えるなら、その選択ステップを返す
 */
function tempBanishStep(run: Running, ctx: Ctx): Step | undefined {
  const state = run.temp;
  const env = makeEnv(state, ctx, run.self);
  const sources = [state.fz, ...state.stz, ...state.mz, ...state.emz].filter(
    (u): u is string => !!u && u !== run.self && state.cards[u].faceUp,
  );
  for (const src of sources) {
    const tb = ctx.scripts?.[env.def(src).id]?.tempBanish;
    if (!tb) continue;
    const usedKey = (uid: string) => `${tb.key}:${env.def(uid).name}`;
    const where = (e: Env, uid: string) =>
      isMonsterZone(e.loc(uid)) && e.state.cards[uid].faceUp && !e.state.effectUses[usedKey(uid)];
    const any = [...state.mz, ...state.emz].some((u) => u && env.matches(u, tb.filter) && where(env, u));
    if (!any) continue;
    return {
      op: 'pick',
      prompt: `${tb.label}：この効果の処理後まで除外するモンスター（任意。戻ると「1ターンに1度」をもう一度使える）`,
      from: ['monsters'],
      filter: tb.filter,
      where,
      min: 0,
      max: 1,
      then: (_, picked) =>
        picked.flatMap((uid) => [
          { type: 'ACTIVATE_EFFECT', uid: src, key: usedKey(uid), limit: 1, silent: true } as Action,
          { type: 'MOVE', uid, to: { zone: 'banished' }, reason: `${tb.label}：効果処理後まで除外` } as Action,
        ]),
    };
  }
  return undefined;
}

export function pickRange(run: Running, ctx: Ctx): [number, number] {
  const step = currentStep(run);
  if (!step || step.op !== 'pick') return [0, 0];
  if (step.count) {
    const n = step.count(stepEnv(run, ctx));
    return [n, n];
  }
  if (step.range) return step.range(stepEnv(run, ctx));
  return [step.min ?? 1, step.max ?? 1];
}

export function stepCandidates(run: Running, ctx: Ctx): string[] {
  const step = currentStep(run);
  if (!step || step.op !== 'pick') return [];
  const env = stepEnv(run, ctx);
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
    // 効果の処理に入る前に「処理後まで除外」を使うか聞く
    if (!cur.extraStep && !cur.tempBanishChecked && !cur.effect.applied && (!step || !step.cost)) {
      cur = { ...cur, tempBanishChecked: true };
      const extra = tempBanishStep(cur, ctx);
      if (extra) {
        cur = { ...cur, extraStep: extra };
        continue;
      }
    }
    if (!step) return finish(cur, ctx);
    if (step.op === 'do') {
      const next = applyAll(cur, ctx, step.then(stepEnv(cur, ctx)));
      if (typeof next === 'string') return { kind: 'error', error: next };
      cur = { ...next, stepIndex: cur.stepIndex + 1 };
      continue;
    }
    if (step.op === 'place') return { kind: 'running', run: { ...cur, stage: 'zone', picked: [] } };
    const [min, max] = pickRange(cur, ctx);
    const cands = stepCandidates(cur, ctx);
    if (cands.length === 0 || max === 0) {
      if (min > 0) return { kind: 'error', error: `選べるカードがありません（${step.prompt}）` };
      cur = cur.extraStep ? { ...cur, extraStep: undefined } : { ...cur, stepIndex: cur.stepIndex + 1 };
      continue;
    }
    return { kind: 'running', run: { ...cur, stage: 'pick', picked: [], mode: 0 } };
  }
}

function finish(run: Running, ctx: Ctx): RunResult {
  let cur = run;
  // 処理後まで除外したモンスターを、除外前と同じ表示形式でメインモンスターゾーンに戻す（空きが無ければ墓地へ）
  if (cur.tempBanished && cur.temp.banished.includes(cur.tempBanished.uid)) {
    const { uid, index, position } = cur.tempBanished;
    const free = cur.temp.mz[index] === null && index >= 0 ? index : cur.temp.mz.indexOf(null);
    const back: Action =
      free >= 0
        ? { type: 'MOVE', uid, to: { zone: 'mz', index: free }, faceUp: true, position, reason: '効果処理後に戻る' }
        : { type: 'MOVE', uid, to: { zone: 'gy' }, reason: '戻るゾーンが無いため墓地へ' };
    const next = applyAll(cur, ctx, [back]);
    if (typeof next === 'string') return { kind: 'error', error: next };
    cur = next;
  }
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
  const env = stepEnv(run, ctx);
  if (run.extraStep && step.op === 'pick') {
    // 処理後まで除外：戻す場所と表示形式を覚えておく
    const uid = run.picked[0];
    const loc = uid ? env.loc(uid) : null;
    const next = applyAll(run, ctx, step.then(env, run.picked, zone, run.mode));
    if (typeof next === 'string') return { kind: 'error', error: next };
    return advance(
      {
        ...next,
        extraStep: undefined,
        tempBanished: uid
          ? { uid, index: loc?.zone === 'mz' ? loc.index : -1, position: run.temp.cards[uid].position }
          : undefined,
      },
      ctx,
    );
  }
  let actions: Action[];
  if (step.op === 'place') actions = step.then(env, zone!);
  else if (step.op === 'pick') actions = step.then(env, run.picked, zone, run.mode);
  else actions = [];
  const next = applyAll(run, ctx, actions);
  if (typeof next === 'string') return { kind: 'error', error: next };
  return advance({ ...next, stepIndex: run.stepIndex + 1, history: [...(run.history ?? []), run.picked] }, ctx);
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
