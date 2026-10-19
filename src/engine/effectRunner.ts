import {
  type Action,
  applyAction,
  candidates,
  type Ctx,
  effectSummonError,
  findLocation,
  isMonsterZone,
  makeEnv,
  missedTiming,
  simultaneousTriggers,
} from './game';
import { oppCanRespond, oppResponse, resolveOppLink } from './oppAI';
import { type EffectDef, type Env, effectText, type Step } from './scripts';
import type { CardDef, GameState, Location } from './types';

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
  /** 処理で選ぶカードがあることを確認済み */
  feasible?: boolean;
  /** 選べるカードが無く、効果を処理できなかった（不発） */
  fizzled?: boolean;
  /** 発動した場所（相手の妨害の判定に使う） */
  from?: string;
}

/** ステップに渡す盤面の見え方（前のステップで選んだカードを含む） */
function stepEnv(run: Running, ctx: Ctx): Env {
  return { ...makeEnv(run.temp, ctx, run.self), picks: run.history ?? [] };
}

export type RunResult =
  | { kind: 'running'; run: Running }
  | { kind: 'done'; action: Action }
  /** blocked：処理で選ぶカードが無いため発動できない */
  | { kind: 'error'; error: string; blocked?: boolean };

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

/** 誘発効果（「〜した場合に発動できる」「召喚・特殊召喚した場合」など。発動しない効果は除く） */
export function isTriggerEffect(effect: EffectDef): boolean {
  return !effect.applied && (!!effect.trigger || !!effect.onSummon);
}

/** 「このカードが召喚した時に発動できる」：召喚の直後でないとタイミングを逃す任意効果 */
export function isTokiTrigger(def: CardDef, effect: EffectDef): boolean {
  if (!effect.onSummon || effect.applied) return false;
  // 番号の無い効果は対象外（全文には別の効果の「時に発動できる」が含まれるため）
  const t = /^[①-⑳]/.test(effect.label) ? effectText(def.text, effect.label) : '';
  return /時に発動できる/.test(t) && !/場合に発動できる/.test(t);
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

/** このターンの使用回数を使い切った効果か（カードを選んだ時に「使用済み」と見せる） */
export function effectUsedUp(state: GameState, ctx: Ctx, uid: string, effect: EffectDef): boolean {
  const used = (key: string, limit: number) => (state.effectUses[key] ?? 0) >= limit;
  const key = effectKey(state, uid, effect);
  if (key && effect.limit !== undefined && used(key, effect.limit)) return true;
  if (nameLimitReached(state, effect)) return true;
  const d = makeEnv(state, ctx, uid).def(uid);
  if (effect.isCardActivation && d.oncePerTurnActivation && state.effectUses[`${d.name}:発動`]) return true;
  if (effect.onSummon) {
    const inst = state.cards[uid];
    const k = effect.applied
      ? `召喚時:${effect.label}:${uid}:${inst.summonedTurn}`
      : `召喚時:${effect.label}:${uid}:${inst.entryId}`;
    if (used(k, 1)) return true;
  }
  return false;
}

/** 今のチェーンに続けて発動できる効果（スペルスピード2以上・使用回数が残っている） */
export function chainableEffects(
  state: GameState,
  ctx: Ctx,
  minSpeed: number,
  /** 戦闘中の各段階で発動できる効果（誘発効果・ダメージステップの効果も含める） */
  inBattle = false,
): { uid: string; effect: EffectDef }[] {
  const out: { uid: string; effect: EffectDef }[] = [];
  const env = makeEnv(state, ctx, '');
  // チェーンが誘発効果だけ：同時に発動条件を満たした他の誘発効果（スペルスピード1）も積める
  const simultaneous = simultaneousTriggers(state);
  const uids = [...state.hand, ...state.mz, ...state.emz, ...state.stz, state.fz, ...state.gy].filter(
    (u): u is string => !!u,
  );
  for (const uid of uids) {
    for (const effect of ctx.scripts?.[env.def(uid).id]?.effects ?? []) {
      if (effect.opponentOnly || !effectAvailable(state, uid, effect)) continue;
      const speed = effectSpeed(state, ctx, uid, effect);
      const battleTrigger = inBattle && (effect.trigger || effect.damageStep);
      const simultaneousTrigger = simultaneous && speed === 1 && isTriggerEffect(effect);
      if (!battleTrigger && !simultaneousTrigger && (speed < 2 || speed < minSpeed)) continue;
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
      // 罠・速攻魔法はセットしたターンには発動できない（手札から発動する速攻魔法は除く）
      const d = env.def(uid);
      if (
        effect.isCardActivation &&
        state.cards[uid].enteredTurn === state.turn &&
        (d.kind === 'trap' || (d.spellType === 'quick' && effectLocation(state, uid) === 'spelltrap'))
      )
        continue;
      // コストを払えて、処理で選ぶカードがあるか
      if (startEffect(state, ctx, uid, effect, undefined, 'never', true).kind === 'error') continue;
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
  /** 発動できるかの確認だけ（チェーンに積まずに最初の選択まで進める） */
  probe = false,
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
  // 戦闘中：起動効果は発動できず、ダメージステップ中に発動できる効果は限られる
  if (ctx.options.strict && state.battle) {
    const speed = effectSpeed(state, ctx, uid, effect);
    if (speed < 2 && !effect.trigger && !effect.onSummon && !effect.damageStep)
      return { kind: 'error', error: '戦闘中は起動効果を発動できません' };
    if (state.battle.step !== 'battle' && !effect.damageStep && speed < 3)
      return {
        kind: 'error',
        error:
          'ダメージステップ中に発動できるのは、攻撃力・守備力を変える効果やダメージ計算時の効果、カウンター罠だけです',
      };
  }
  // 効果を無効にされたカード（エフェクト・ヴェーラー・無限泡影など）は、このターン効果を発動できない
  if (ctx.options.strict && state.cards[uid]?.negatedTurn === state.turn && isMonsterZone(findLocation(state, uid)))
    return { kind: 'error', error: 'このカードの効果はこのターン無効になっています' };
  // 「召喚した時に発動できる」任意効果は、召喚の後に別の何かが起きるとタイミングを逃す
  if (ctx.options.strict && isTokiTrigger(env.def(uid), effect) && missedTiming(state, uid))
    return {
      kind: 'error',
      error: 'タイミングを逃しました（「〜した時に発動できる」効果は、その直後にしか発動できません）',
    };
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
    // 「召喚・特殊召喚した時に適用する」効果は、召喚した後に一時的に除外されて戻ってきても、
    // まだ適用していなければ適用できる（追加の召喚権などはこのターンの間残るため）
    const summoned = effect.applied
      ? inst.summonedTurn === state.turn
      : inst.enteredTurn === state.turn && inst.summonedEntry === inst.entryId;
    if (!summoned) return { kind: 'error', error: 'このターンに召喚・特殊召喚されたカードではありません' };
    // 召喚1回につき1度だけ（ターン1の制限とは別に管理）
    batch.push({
      type: 'ACTIVATE_EFFECT',
      uid,
      silent: true,
      key: effect.applied
        ? `召喚時:${effect.label}:${uid}:${inst.summonedTurn}`
        : `召喚時:${effect.label}:${uid}:${inst.entryId}`,
      limit: 1,
    });
  }
  let r = applyAction(state, first, ctx);
  for (const a of batch.slice(1)) if (r.ok) r = applyAction(r.state, a, ctx);
  if (!r.ok) return { kind: 'error', error: r.error };
  const res = advance(
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
      chainMode: probe ? 'never' : state.chain?.length ? 'force' : chainMode,
      resolving: false,
      from: effectLocation(state, uid) ?? undefined,
    },
    ctx,
  );
  // コストを選ぶ前に、コストを払った後で効果を処理できるか確かめる
  if (res.kind === 'running') {
    const blocked = costLookaheadBlocked(res.run, ctx);
    if (blocked) return { kind: 'error', error: blocked, blocked: true };
  }
  return res;
}

/**
 * コストの選択で止まっている時、いくつかの選び方でコストを払ってみて、効果を処理できる選び方があるか確かめる。
 * どの選び方でも処理で選ぶカードが無い場合だけ、その理由を返す
 */
function costLookaheadBlocked(run: Running, ctx: Ctx, depth = 0): string | null {
  const step = currentStep(run);
  if (run.extraStep || run.stage !== 'pick' || step?.op !== 'pick' || !step.cost || depth > 2) return null;
  const cands = stepCandidates(run, ctx);
  const [min] = pickRange(run, ctx);
  if (cands.length < min) return `選べるカードがありません（${step.prompt}）`;
  let reason: string | null = null;
  const tries = min === 0 ? 1 : Math.min(cands.length, 8);
  for (let i = 0; i < tries; i++) {
    const picked = Array.from({ length: min }, (_, k) => cands[(i + k) % cands.length]);
    const r = completeStep({ ...run, chainMode: 'never', picked }, ctx, null);
    if (r.kind === 'error') {
      if (!r.blocked) return null;
      reason = r.error;
      continue;
    }
    if (r.kind === 'running') {
      const sub = costLookaheadBlocked(r.run, ctx, depth + 1);
      if (!sub) return null;
      reason = sub;
      continue;
    }
    return null;
  }
  return reason;
}

/** チェーンの一番上の効果を解決する */
export function startResolve(state: GameState, ctx: Ctx): RunResult {
  const link = state.chain[state.chain.length - 1];
  if (!link) return { kind: 'error', error: '解決するチェーンがありません' };
  const name = makeEnv(state, ctx, link.uid).def(link.uid).name;
  const no = state.chain.length;
  // 相手の妨害：自動で処理する
  if (link.opp) {
    const actions = [...resolveOppLink(state, ctx, link), { type: 'CHAIN_POP' } as Action];
    return { kind: 'done', action: { type: 'BATCH', label: `チェーン${no}を解決：相手の${name}`, actions } };
  }
  // 無効にされた効果：処理せず、破壊されたカード・発動した魔法・罠は墓地へ
  if (link.negated) {
    const inst = state.cards[link.uid];
    const loc = findLocation(state, link.uid);
    const onField = !!loc && ['mz', 'emz', 'stz', 'fz'].includes(loc.zone);
    const actions: Action[] =
      link.negated === 'destroy' && onField
        ? [{ type: 'MOVE', uid: link.uid, to: { zone: 'gy' }, reason: '効果で破壊' }]
        : inst?.pendingResolve
          ? [{ type: 'RESOLVE', uid: link.uid }]
          : [];
    return {
      kind: 'done',
      action: {
        type: 'BATCH',
        label: `チェーン${no}：${name}は無効になった`,
        actions: [...actions, { type: 'CHAIN_POP', fizzled: true }],
      },
    };
  }
  const effect = ctx.scripts?.[link.defId]?.effects?.[link.effect];
  if (!effect) return { kind: 'error', error: '効果が見つかりません' };
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

/** チェーンの一番上の効果を処理しない（不発にする）。発動した魔法・罠は墓地へ送る */
export function fizzleTop(state: GameState, ctx: Ctx): Action | null {
  const link = state.chain[state.chain.length - 1];
  if (!link) return null;
  const name = makeEnv(state, ctx, link.uid).def(link.uid).name;
  const actions: Action[] = state.cards[link.uid]?.pendingResolve ? [{ type: 'RESOLVE', uid: link.uid }] : [];
  return {
    type: 'BATCH',
    label: `チェーン${state.chain.length}：${name}は不発`,
    actions: [...actions, { type: 'CHAIN_POP', fizzled: true }],
  };
}

/** コストを払い終えたところでチェーンに積むか決める */
function pushToChain(run: Running, ctx: Ctx): RunResult | null {
  if (run.chainMode === 'never' || run.resolving || run.effect.applied) return null;
  const speed = effectSpeed(run.temp, ctx, run.self, run.effect);
  const responses = chainableEffects(run.temp, ctx, Math.max(2, speed)).filter((c) => c.uid !== run.self);
  const def = makeEnv(run.temp, ctx, run.self).def(run.self);
  const index = ctx.scripts?.[def.id]?.effects?.indexOf(run.effect) ?? -1;
  if (index < 0) return null;
  const trigger = speed === 1 && isTriggerEffect(run.effect);
  const push: Action = {
    type: 'CHAIN_PUSH',
    uid: run.self,
    effect: index,
    stepStart: run.stepIndex,
    speed,
    label: run.effect.label,
    from: run.from,
    ...(trigger ? { trigger: true } : {}),
  };
  const r = applyAction(run.temp, push, ctx);
  if (!r.ok) return { kind: 'error', error: r.error };
  // 誘発効果：同時に発動条件を満たした他の誘発効果があれば、チェーンを組めるように止める
  if (trigger)
    responses.push(
      ...chainableEffects(r.state, ctx, 2).filter(
        (c) => c.uid !== run.self && !responses.some((x) => x.uid === c.uid && x.effect === c.effect),
      ),
    );
  // 通信対戦：相手が妨害を使えるなら、チェーンに積んで相手の応答を待つ
  if (ctx.options.oppAsk && oppCanRespond(r.state, ctx))
    return { kind: 'done', action: { type: 'BATCH', label: run.title, actions: [...run.batch, push] } };
  // 相手（練習用の相手AI）が妨害をチェーンしてくるか
  const opp = ctx.options.strict && ctx.options.oppAI !== false ? oppResponse(r.state, ctx) : null;
  if (run.chainMode === 'auto' && responses.length === 0 && !opp) return null;
  return { kind: 'done', action: { type: 'BATCH', label: run.title, actions: [...run.batch, push, ...(opp ?? [])] } };
}

function applyAll(run: Running, ctx: Ctx, input: Action[]): Running | string {
  let temp = run.temp;
  // 処理の区切り（同じ区切りの中で起きたことは同時に起きたものとして扱う）
  const actions: Action[] = input.length ? [{ type: 'TIMING' }, ...input] : input;
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
  // 選んだカードを特殊召喚するステップでは、特殊召喚できないカードを外す
  const summons = step.zone === 'monster' && !step.zoneIf && !step.noSummonCheck;
  return candidates(run.temp, step.from).filter(
    (u) =>
      (!step.filter || env.matches(u, step.filter)) &&
      (!step.where || step.where(env, u)) &&
      (!summons ||
        env.def(u).kind !== 'monster' ||
        isMonsterZone(findLocation(run.temp, u)) ||
        !effectSummonError(run.temp, ctx, u)),
  );
}

/**
 * 発動できるか（効果の処理で最初に選ぶカードがあるか）を、コストを払った後の盤面で確かめる。
 * 選べるカードが無い効果は発動できない（チェーンに積んでから不発になるのを防ぐ）
 */
function resolutionBlocked(run: Running, ctx: Ctx): string | null {
  let sim: Running = { ...run, extraStep: undefined };
  for (let i = run.stepIndex; i < run.effect.steps.length; i++) {
    const step = run.effect.steps[i];
    if (step.op === 'place') {
      if (step.zone !== 'monster') return null;
      if (!zoneChoices({ ...sim, stepIndex: i, stage: 'zone', picked: [] }).length)
        return 'モンスターゾーンに空きがありません';
      return effectSummonError(sim.temp, ctx, run.self);
    }
    if (step.op === 'do') {
      const next = applyAll(sim, ctx, step.then(stepEnv(sim, ctx)));
      if (typeof next === 'string') return null;
      sim = { ...next, stepIndex: i + 1 };
      continue;
    }
    sim = { ...sim, stepIndex: i };
    const [min] = pickRange(sim, ctx);
    if (min > 0 && stepCandidates(sim, ctx).length < min) return `選べるカードがありません（${step.prompt}）`;
    if (min > 0 && step.zone && !step.zoneIf && !step.noSummonCheck) {
      // EXデッキのカードを出すならEXモンスターゾーンも使える
      const fromExtra = stepCandidates(sim, ctx).find((u) => findLocation(sim.temp, u)?.zone === 'extra');
      if (!zoneChoices({ ...sim, stage: 'zone', picked: fromExtra ? [fromExtra] : [] }).length)
        return step.zone === 'stz' ? '魔法＆罠ゾーンに空きがありません' : 'モンスターゾーンに空きがありません';
    }
    return null;
  }
  return null;
}

/** 選択不要なステップを進め、選択が必要なところで止まる */
export function advance(run: Running, ctx: Ctx): RunResult {
  let cur = run;
  for (;;) {
    const step = currentStep(cur);
    // コストを払い終えたら、効果を処理できるか確かめる
    if (!cur.resolving && !cur.feasible && !cur.extraStep && (!step || !step.cost)) {
      const blocked = resolutionBlocked(cur, ctx);
      if (blocked) return { kind: 'error', error: blocked, blocked: true };
      cur = { ...cur, feasible: true };
    }
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
    if (step.op === 'place') {
      const next: Running = { ...cur, stage: 'zone', picked: [] };
      const cannot = step.zone === 'monster' && effectSummonError(cur.temp, ctx, cur.self);
      if (cannot && cur.resolving)
        return finish({ ...cur, title: `${cur.title}（${cannot}・不発）`, fizzled: true }, ctx);
      if (cannot) return { kind: 'error', error: cannot };
      if (zoneChoices(next).length) return { kind: 'running', run: next };
      if (cur.resolving)
        return finish({ ...cur, title: `${cur.title}（出すゾーンが無いため不発）`, fizzled: true }, ctx);
      return {
        kind: 'error',
        error: step.zone === 'stz' ? '魔法＆罠ゾーンに空きがありません' : 'モンスターゾーンに空きがありません',
      };
    }
    const [min, max] = pickRange(cur, ctx);
    const cands = stepCandidates(cur, ctx);
    if (cands.length === 0 || max === 0) {
      // チェーンの解決中に選べるカードが無くなっていたら、効果は不発になる
      if (min > 0 && cur.resolving)
        return finish({ ...cur, title: `${cur.title}（選べるカードが無いため不発）`, fizzled: true }, ctx);
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
  const actions = run.resolving ? [...cur.batch, { type: 'CHAIN_POP', fizzled: run.fizzled } as Action] : cur.batch;
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
  if (step.zone && (!step.zoneIf || step.zoneIf(stepEnv(run, ctx), run.picked, run.mode))) {
    const next: Running = { ...run, stage: 'zone' };
    if (zoneChoices(next).length) return { kind: 'running', run: next };
    // 出すゾーンが無い：解決中なら不発、発動中なら選び直し
    if (run.resolving) return finish({ ...run, title: `${run.title}（出すゾーンが無いため不発）`, fizzled: true }, ctx);
    return {
      kind: 'error',
      error: step.zone === 'stz' ? '魔法＆罠ゾーンに空きがありません' : 'モンスターゾーンに空きがありません',
    };
  }
  return completeStep(run, ctx, null);
}

/** ゾーン選択で選べるゾーン（空いているゾーンと、素材として離れるカードのゾーン） */
export function zoneChoices(run: Running): Location[] {
  const step = currentStep(run);
  const t = run.temp;
  const kind = step?.op === 'pick' || step?.op === 'place' ? (step.zone ?? null) : null;
  const idx = [0, 1, 2, 3, 4];
  if (kind === 'stz') return idx.filter((i) => !t.stz[i]).map((index) => ({ zone: 'stz', index }));
  if (kind !== 'monster') return [];
  // 融合・儀式の素材として選んだフィールドのカードは、出す前に離れる
  const leaving = new Set(step?.op === 'pick' && step.noSummonCheck ? run.picked : []);
  const free = (u: string | null) => !u || leaving.has(u);
  const out: Location[] = idx.filter((i) => free(t.mz[i])).map((index) => ({ zone: 'mz', index }));
  // EXデッキから出すモンスター（選んだカードか、融合で先に選んだ融合モンスター）はEXモンスターゾーンにも出せる
  const source = run.picked[0] ?? '';
  const fusion = step?.op === 'pick' && step.noSummonCheck ? (run.history?.[0]?.[0] ?? '') : '';
  // EXモンスターゾーンは1つしか使えない（もう片方を使っていれば出せない）
  const emzUsed = t.emz.some((u) => !free(u));
  if (!emzUsed && (findLocation(t, source)?.zone === 'extra' || findLocation(t, fusion)?.zone === 'extra'))
    out.push(
      ...[0, 1].filter((i) => free(t.emz[i]) && !t.opp?.emz?.[i]).map((index) => ({ zone: 'emz' as const, index })),
    );
  return out;
}

export function runZoneKind(run: Running): 'monster' | 'stz' | null {
  const step = currentStep(run);
  if (run.stage !== 'zone' || !step) return null;
  if (step.op === 'place') return step.zone;
  if (step.op === 'pick') return step.zone ?? null;
  return null;
}
