import {
  afterPick,
  completeStep,
  currentStep,
  fizzleTop,
  pickRange,
  type RunResult,
  startEffect,
  startResolve,
  stepCandidates,
  zoneChoices,
} from './effectRunner';
import { actionUids } from './coach';
import { type Action, applyAction, type Ctx, getDef } from './game';
import { forceOppResponse, handTrapAbility } from './oppAI';
import type { EffectDef } from './scripts';
import type { GameState, Location } from './types';

// CPU戦：CPU（先攻）の展開に、プレイヤー（後攻）が手札誘発を使う。
// CPUのゲームでは CPU が「自分」、プレイヤーが「相手」（相手の盤面・相手のチェーン）として扱う。

/** CPUがこれから行う操作の中身 */
export interface CpuStep {
  kind: 'activate' | 'summon' | 'other';
  uid?: string;
  effect?: EffectDef;
  zone?: Location;
  /** 画面に出す説明 */
  text: string;
}

export function describeCpuStep(cpu: GameState, ctx: Ctx, action: Action): CpuStep {
  const first = action.type === 'BATCH' ? action.actions[0] : action;
  const nameOf = (u: string) => (cpu.cards[u] ? getDef(cpu, ctx, u).name : '?');
  if (first && (first.type === 'ACTIVATE_EFFECT' || first.type === 'ACTIVATE_CARD') && cpu.cards[first.uid]) {
    const effects = ctx.scripts?.[cpu.cards[first.uid].defId]?.effects ?? [];
    const effect =
      first.type === 'ACTIVATE_CARD'
        ? effects.find((e) => e.isCardActivation)
        : effects.find((e) => e.label === first.label);
    const zone: Location | undefined =
      first.type === 'ACTIVATE_CARD' && first.index !== undefined ? { zone: 'stz', index: first.index } : undefined;
    return {
      kind: effect && !effect.applied ? 'activate' : 'other',
      uid: first.uid,
      effect,
      zone,
      text: `${nameOf(first.uid)}${effect ? `：${effect.label}` : 'を発動'}`,
    };
  }
  const summon = (t: string) => ({
    kind: 'summon' as const,
    uid: first && 'uid' in first ? first.uid : undefined,
    text: t,
  });
  if (first?.type === 'NORMAL_SUMMON') return summon(`${nameOf(first.uid)}を召喚`);
  if (first?.type === 'SPECIAL_SUMMON' || first?.type === 'PROC_SUMMON' || first?.type === 'PROCEDURE_SUMMON')
    return summon(`${nameOf(first.uid)}を特殊召喚`);
  if (first?.type === 'SET_SPELL_TRAP') return { kind: 'other', uid: first.uid, text: 'カードを1枚伏せる' };
  return { kind: 'other', text: action.type === 'BATCH' ? (action.label ?? '操作') : '操作' };
}

/**
 * 効果の処理を、CPUが自動で選びながら進める。prefer に入っているカード（予定していたルートで使うカード）を優先して選ぶ
 */
export function autoDrive(r: RunResult, ctx: Ctx, prefer: Set<string>): Action | null {
  for (let guard = 0; guard < 40; guard++) {
    if (r.kind === 'done') return r.action;
    if (r.kind === 'error') return null;
    const run = r.run;
    if (run.stage === 'pick') {
      const cands = stepCandidates(run, ctx);
      const [min, max] = pickRange(run, ctx);
      const ordered = [...cands.filter((u) => prefer.has(u)), ...cands.filter((u) => !prefer.has(u))];
      const want = Math.max(min, Math.min(max, cands.filter((u) => prefer.has(u)).length));
      if (ordered.length < min) return null;
      r = afterPick({ ...run, picked: ordered.slice(0, want) }, ctx);
    } else if (run.stage === 'mode') {
      r = afterPick({ ...run, mode: 0, stage: 'mode' }, ctx);
    } else {
      const zones = zoneChoices(run);
      if (!zones.length && currentStep(run)) return null;
      r = completeStep(run, ctx, zones[0] ?? null);
    }
  }
  return null;
}

/** CPUの効果の発動を、コストを払ってチェーンに積むところまで行う（手札誘発をチェーンするため） */
export function pushCpuActivation(
  cpu: GameState,
  ctx: Ctx,
  step: CpuStep,
  prefer: Set<string>,
): { action: Action; state: GameState } | null {
  if (step.kind !== 'activate' || !step.uid || !step.effect) return null;
  const action = autoDrive(startEffect(cpu, ctx, step.uid, step.effect, step.zone, 'force'), ctx, prefer);
  if (!action) return null;
  const r = applyAction(cpu, action, ctx);
  if (!r.ok || r.state.chain.length <= cpu.chain.length) return null;
  return { action, state: r.state };
}

/** プレイヤーが使える手札誘発 */
export interface HandTrapOption {
  /** プレイヤーの手札のカード */
  uid: string;
  name: string;
  label: string;
  kind: 'chain' | 'draw' | 'droll';
  abilityId?: string;
}

const DRAW_TRAPS: Record<string, string> = {
  増殖するＧ: '相手が特殊召喚するたびに1枚ドロー',
  'マルチャミー・フワロス': '相手がデッキ・EXから特殊召喚するたびに1枚ドロー（自分フィールドにカードが無い時）',
};

/** CPUのこの操作に対して、プレイヤーが使える手札誘発 */
export function handTrapOptions(
  cpu: GameState,
  human: GameState,
  ctx: Ctx,
  action: Action,
  usedNames: string[],
): HandTrapOption[] {
  const step = describeCpuStep(cpu, ctx, action);
  const out: HandTrapOption[] = [];
  const seen = new Set<string>();
  const humanField = [...human.mz, ...human.emz, ...human.stz, human.fz].some(Boolean);
  const pushed = step.kind === 'activate' ? pushCpuActivation(cpu, ctx, step, new Set(actionUids(action))) : null;
  for (const uid of human.hand) {
    const name = getDef(human, ctx, uid).name;
    if (seen.has(name) || usedNames.includes(name)) continue;
    seen.add(name);
    if (DRAW_TRAPS[name] && step.kind !== 'other') {
      if (name === 'マルチャミー・フワロス' && humanField) continue;
      out.push({ uid, name, label: DRAW_TRAPS[name], kind: 'draw' });
      continue;
    }
    if (name === 'ドロール＆ロックバード') {
      if (cpu.deckToHandTurn === cpu.turn && cpu.noDeckToHandTurn !== cpu.turn)
        out.push({ uid, name, label: 'このターン、お互いにデッキからカードを手札に加えられなくする', kind: 'droll' });
      continue;
    }
    const ability = handTrapAbility(name);
    if (!ability || !pushed) continue;
    const placed = applyAction(
      pushed.state,
      { type: 'OPP_PLACE', defId: human.cards[uid].defId, to: { zone: 'ohand' }, faceUp: false },
      ctx,
    );
    if (placed.ok && forceOppResponse(placed.state, ctx, ability.id))
      out.push({ uid, name, label: ability.label, kind: 'chain', abilityId: ability.id });
  }
  return out;
}

/** 手札誘発を使った結果：CPUのゲームに行う操作と、プレイヤーのゲームに行う操作 */
export interface HandTrapResult {
  cpuActions: Action[];
  humanActions: Action[];
  /** CPUの効果が止まった（ルートを探し直す） */
  replan: boolean;
}

export function applyHandTrap(
  cpu: GameState,
  ctx: Ctx,
  action: Action,
  option: HandTrapOption,
  humanDefId: string,
): HandTrapResult | null {
  const humanActions: Action[] = [
    { type: 'MOVE', uid: option.uid, to: { zone: 'gy' }, reason: `${option.name}を発動（CPUの効果に対して）` },
  ];
  if (option.kind === 'draw') return { cpuActions: [], humanActions, replan: false };
  if (option.kind === 'droll')
    return { cpuActions: [{ type: 'NO_DECK_TO_HAND', by: option.name }], humanActions, replan: true };
  const prefer = new Set(actionUids(action));
  const pushed = pushCpuActivation(cpu, ctx, describeCpuStep(cpu, ctx, action), prefer);
  if (!pushed || !option.abilityId) return null;
  const cpuActions: Action[] = [pushed.action];
  let s = pushed.state;
  const apply = (a: Action): boolean => {
    const r = applyAction(s, a, ctx);
    if (!r.ok) return false;
    s = r.state;
    cpuActions.push(a);
    return true;
  };
  if (!apply({ type: 'OPP_PLACE', defId: humanDefId, to: { zone: 'ohand' }, faceUp: false })) return null;
  const resp = forceOppResponse(s, ctx, option.abilityId);
  if (!resp || !apply({ type: 'BATCH', label: `（あなた）${option.name}`, actions: resp })) return null;
  // チェーンを上から解決する（CPUの選択は予定のルートに沿って自動で行う）
  for (let guard = 0; s.chain.length && guard < 10; guard++) {
    const a = autoDrive(startResolve(s, ctx), ctx, prefer) ?? fizzleTop(s, ctx);
    if (!a || !apply(a)) break;
  }
  return { cpuActions, humanActions, replan: true };
}

/** この操作で新しく特殊召喚されたモンスターの数（増殖するＧのドロー） */
export function specialSummonsBetween(before: GameState, after: GameState): number {
  let n = 0;
  for (const [u, inst] of Object.entries(after.cards)) {
    if (inst.opp || inst.summonedEntry === null || inst.summonedEntry !== inst.entryId) continue;
    if (inst.summonType === 'normal' || inst.summonedTurn !== after.turn) continue;
    if (before.cards[u]?.summonedEntry !== inst.summonedEntry) n++;
  }
  return n;
}

/** CPUの盤面を、プレイヤーのゲームの相手の盤面として写す操作 */
export function syncAction(cpu: GameState): Action {
  const cards: Extract<Action, { type: 'OPP_SYNC' }>['cards'] = [];
  const add = (uid: string | null, zone: (typeof cards)[number]['zone'], index?: number) => {
    if (!uid || cpu.cards[uid]?.opp) return;
    const inst = cpu.cards[uid];
    cards.push({
      key: uid,
      defId: inst.defId,
      zone,
      index,
      faceUp: zone === 'ohand' ? false : inst.faceUp,
      position: inst.position,
      equipTo: inst.equippedTo ?? undefined,
      mods: {
        atkMod: inst.atkMod,
        defMod: inst.defMod,
        turnAtkMod: inst.turnAtkMod,
        turnDefMod: inst.turnDefMod,
        atkSet: inst.atkSet,
        equipAtk: inst.equipAtk,
        equipDef: inst.equipDef,
      },
    });
  };
  cpu.mz.forEach((u, i) => add(u, 'omz', i));
  // EXモンスターゾーンは共有：CPUから見て左はこちらから見て右
  cpu.emz.forEach((u, i) => add(u, 'oemz', 1 - i));
  cpu.stz.forEach((u, i) => add(u, 'ostz', i));
  add(cpu.fz, 'ofz');
  cpu.gy.forEach((u) => add(u, 'ogy'));
  cpu.banished.forEach((u) => add(u, 'obanished'));
  cpu.hand.forEach((u) => add(u, 'ohand'));
  return { type: 'OPP_SYNC', cards, lp: cpu.lp };
}
