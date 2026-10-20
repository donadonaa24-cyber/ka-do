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
import { type Action, applyAction, type Ctx, findLocation, getDef } from './game';
import { forceFreeResponse, forceOppResponse, freeAbilityChoices, oppAbilityChoices } from './oppAI';
import type { EffectDef } from './scripts';
import type { GameState, Location } from './types';

// CPU戦：CPUの展開に、プレイヤーが手札誘発や盤面の妨害を使う（CPUが先攻でも後攻でも）。
// CPUのゲームでは CPU が「自分」、プレイヤーが「相手」（相手の盤面・相手のチェーン）として扱う。
// プレイヤーのカードは syncAction で CPUのゲームの相手の盤面に写し、CPUのゲームで動いたら reverseSync で戻す。

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

/** プレイヤーが使える手札誘発・盤面の妨害 */
export interface HandTrapOption {
  /** プレイヤーのカード（手札・フィールド） */
  uid: string;
  name: string;
  label: string;
  /** 手札から・フィールドから */
  from: 'hand' | 'field';
  /** chain：CPUの効果の発動にチェーンする／free：CPUの召喚の後に発動する（白き龍の威光など） */
  kind: 'chain' | 'free' | 'draw' | 'droll';
  abilityId?: string;
}

const DRAW_TRAPS: Record<string, string> = {
  増殖するＧ: '相手が特殊召喚するたびに1枚ドロー',
  'マルチャミー・フワロス': '相手がデッキ・EXから特殊召喚するたびに1枚ドロー（自分フィールドにカードが無い時）',
};

const PSY_GEARS = new Set(['ＰＳＹフレームギア・γ', 'ＰＳＹフレームギア・δ']);

/** ＰＳＹフレームギアと一緒に特殊召喚する、手札・デッキ・墓地の「ＰＳＹフレーム・ドライバー」 */
function psyDriver(human: GameState, ctx: Ctx): string | undefined {
  return [...human.hand, ...human.deck, ...human.gy].find(
    (u) => getDef(human, ctx, u).name === 'ＰＳＹフレーム・ドライバー',
  );
}

/** プレイヤーの盤面・手札・墓地・除外が、CPUのゲームに写っているか（変わったら写し直す）の目印 */
export function humanSignature(human: GameState): string {
  const ids = (us: (string | null)[]) =>
    us.map((u) => (u ? `${u}${human.cards[u]?.faceUp ? '+' : '-'}` : '_')).join(',');
  return [
    ids(human.mz),
    ids(human.emz),
    ids(human.stz),
    ids([human.fz]),
    ids(human.hand),
    ids(human.gy),
    ids(human.banished),
    human.lp,
  ].join('|');
}

/**
 * CPUのこの操作に対して、プレイヤーが使える手札誘発・盤面の妨害。
 * cpu にはプレイヤーのカードが相手の盤面として写っていること（syncAction(human)）
 */
export function handTrapOptions(
  cpu: GameState,
  human: GameState,
  ctx: Ctx,
  action: Action,
  usedNames: string[],
): HandTrapOption[] {
  const step = describeCpuStep(cpu, ctx, action);
  const out: HandTrapOption[] = [];
  const humanField = [...human.mz, ...human.emz, ...human.stz, human.fz].some(Boolean);
  const humanMonsters = [...human.mz, ...human.emz].some(Boolean);
  const seen = new Set<string>();
  // 効果を止めない手札誘発（増殖するＧ・ドロール）
  for (const uid of human.hand) {
    const name = getDef(human, ctx, uid).name;
    if (seen.has(name) || usedNames.includes(name)) continue;
    seen.add(name);
    if (DRAW_TRAPS[name] && step.kind !== 'other') {
      if (name === 'マルチャミー・フワロス' && humanField) continue;
      out.push({ uid, name, label: DRAW_TRAPS[name], from: 'hand', kind: 'draw' });
    } else if (
      name === 'ドロール＆ロックバード' &&
      cpu.deckToHandTurn === cpu.turn &&
      cpu.noDeckToHandTurn !== cpu.turn
    )
      out.push({
        uid,
        name,
        label: 'このターン、お互いにデッキからカードを手札に加えられなくする',
        from: 'hand',
        kind: 'droll',
      });
  }
  // CPUの召喚の後に発動できる罠（白き龍の威光など）
  if (step.kind === 'summon') {
    const after = applyAction(cpu, action, ctx);
    if (after.ok && !after.state.chain.length)
      for (const c of freeAbilityChoices(after.state, ctx)) {
        const uid = after.state.cards[c.uid]?.syncKey;
        if (!uid || !human.cards[uid]) continue;
        const name = getDef(human, ctx, uid).name;
        out.push({ uid, name, label: `${c.label}（召喚の後に発動）`, from: 'field', kind: 'free', abilityId: c.id });
      }
  }
  // CPUの効果の発動にチェーンして止めるもの（手札誘発・フィールドの妨害）
  const pushed = step.kind === 'activate' ? pushCpuActivation(cpu, ctx, step, new Set(actionUids(action))) : null;
  if (!pushed) return out;
  const chosen = new Set<string>();
  for (const c of oppAbilityChoices(pushed.state, ctx)) {
    const uid = pushed.state.cards[c.uid]?.syncKey;
    if (!uid || !human.cards[uid]) continue;
    const name = getDef(human, ctx, uid).name;
    if (chosen.has(`${c.id}:${name}`)) continue;
    chosen.add(`${c.id}:${name}`);
    // ＰＳＹフレームギア：ドライバーを一緒に特殊召喚できる時だけ
    if (PSY_GEARS.has(name) && (humanMonsters || !psyDriver(human, ctx))) continue;
    out.push({
      uid,
      name,
      label: c.label,
      from: human.hand.includes(uid) ? 'hand' : 'field',
      kind: 'chain',
      abilityId: c.id,
    });
  }
  return out;
}

/** 手札誘発を使った結果：CPUのゲームに行う操作と、プレイヤーのゲームに行う操作 */
export interface HandTrapResult {
  cpuActions: Action[];
  humanActions: Action[];
  /** CPUの効果が止まった（ルートを探し直す） */
  replan: boolean;
  /** エンドフェイズに除外する、プレイヤーのモンスター（ＰＳＹフレームギアの効果で特殊召喚したもの） */
  banishAtEnd?: string[];
  /** CPUのゲームでの動きをプレイヤーのゲームに戻さないカード（humanActions で動かすもの） */
  keep: string[];
}

export function applyHandTrap(
  cpu: GameState,
  ctx: Ctx,
  action: Action,
  option: HandTrapOption,
  human: GameState,
): HandTrapResult | null {
  let humanActions: Action[] = [];
  let banishAtEnd: string[] | undefined;
  if (option.kind !== 'chain')
    humanActions = [
      { type: 'MOVE', uid: option.uid, to: { zone: 'gy' }, reason: `${option.name}を発動（CPUの効果に対して）` },
    ];
  // ＰＳＹフレームギア：手札のこのカードとドライバーを特殊召喚（エンドフェイズに除外される）
  if (PSY_GEARS.has(option.name)) {
    const driver = psyDriver(human, ctx);
    const free = human.mz.flatMap((u, i) => (u ? [] : [i]));
    if (!driver || free.length < 2) return null;
    const fromDeck = human.deck.includes(driver);
    humanActions = [
      {
        type: 'MOVE',
        uid: option.uid,
        to: { zone: 'mz', index: free[0] },
        faceUp: true,
        position: 'atk',
        reason: '自身の効果で特殊召喚',
      },
      {
        type: 'MOVE',
        uid: driver,
        to: { zone: 'mz', index: free[1] },
        faceUp: true,
        position: 'atk',
        reason: `${option.name}の効果で特殊召喚`,
      },
      ...(fromDeck ? [{ type: 'SHUFFLE_DECK' } as Action] : []),
    ];
    banishAtEnd = [option.uid, driver];
  }
  const keep = humanActions.flatMap((a) => (a.type === 'MOVE' ? [a.uid] : []));
  if (option.kind === 'draw') return { cpuActions: [], humanActions, replan: false, keep };
  if (option.kind === 'droll')
    return { cpuActions: [{ type: 'NO_DECK_TO_HAND', by: option.name }], humanActions, replan: true, keep };
  const prefer = new Set(actionUids(action));
  // 召喚の後に発動：召喚してから、チェーン1として発動する
  const after = option.kind === 'free' ? applyAction(cpu, action, ctx) : null;
  const pushed =
    option.kind === 'free'
      ? after?.ok
        ? { action, state: after.state }
        : null
      : pushCpuActivation(cpu, ctx, describeCpuStep(cpu, ctx, action), prefer);
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
  const resp =
    option.kind === 'free' ? forceFreeResponse(s, ctx, option.abilityId) : forceOppResponse(s, ctx, option.abilityId);
  if (!resp || !apply({ type: 'BATCH', label: `（あなた）${option.name}`, actions: resp })) return null;
  // チェーンを上から解決する（CPUの選択は予定のルートに沿って自動で行う）
  for (let guard = 0; s.chain.length && guard < 10; guard++) {
    const a = autoDrive(startResolve(s, ctx), ctx, prefer) ?? fizzleTop(s, ctx);
    if (!a || !apply(a)) break;
  }
  return { cpuActions, humanActions, replan: true, banishAtEnd, keep };
}

/** 相手の盤面の場所を、そのカードの持ち主から見た場所にする */
function ownZone(loc: Location): Location | null {
  if (loc.zone === 'omz') return { zone: 'mz', index: loc.index };
  // EXモンスターゾーンは共有：相手から見て左はこちらから見て右
  if (loc.zone === 'oemz') return { zone: 'emz', index: 1 - loc.index };
  if (loc.zone === 'ostz') return { zone: 'stz', index: loc.index };
  if (loc.zone === 'ofz') return { zone: 'fz' };
  return null;
}

/**
 * CPUのゲームで動いたプレイヤーのカード（破壊された・妨害に使った・表になったなど）を、
 * プレイヤーのゲームにも反映する操作。keep のカードは反映しない
 */
export function reverseSync(cpu: GameState, human: GameState, keep: string[] = []): Action[] {
  const cat = (zone: string | undefined) =>
    !zone
      ? null
      : ['mz', 'emz', 'stz', 'fz', 'omz', 'oemz', 'ostz', 'ofz'].includes(zone)
        ? 'field'
        : zone.replace(/^o/, '');
  const out: Action[] = [];
  for (const [u, inst] of Object.entries(cpu.cards)) {
    const hu = inst.syncKey;
    if (!inst.opp || !hu || keep.includes(hu) || !human.cards[hu]) continue;
    const cpuLoc = findLocation(cpu, u);
    const hLoc = findLocation(human, hu);
    const c = cat(cpuLoc?.zone);
    if (!c || !hLoc) continue;
    if (c !== cat(hLoc.zone)) {
      if (c === 'gy' || c === 'banished' || c === 'hand')
        out.push({ type: 'MOVE', uid: hu, to: { zone: c }, reason: 'CPUのゲームで' });
      else if (c === 'field' && cpuLoc && inst.banishAtEnd) {
        // ＰＳＹフレームギアの効果で相手のフィールドに特殊召喚されたカード：こちらから見た同じ場所へ
        const to = ownZone(cpuLoc);
        if (to)
          out.push(
            { type: 'MOVE', uid: hu, to, faceUp: true, position: inst.position, reason: '効果で特殊召喚' },
            { type: 'BANISH_AT_END', uid: hu },
          );
      }
    } else if (c === 'field' && inst.faceUp !== human.cards[hu].faceUp) {
      out.push({ type: 'MOVE', uid: hu, to: hLoc, faceUp: inst.faceUp, position: human.cards[hu].position });
    }
  }
  return out;
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
      faceUp: zone === 'ohand' || zone === 'odeck' ? false : inst.faceUp,
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
  // デッキも写す（見せない。ＰＳＹフレームギアがデッキのドライバーを特殊召喚するため）
  cpu.deck.forEach((u) => add(u, 'odeck'));
  return { type: 'OPP_SYNC', cards, lp: cpu.lp, extra: cpu.extra.length };
}
