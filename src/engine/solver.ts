import {
  afterPick,
  completeStep,
  effectAvailable,
  pickRange,
  type RunResult,
  startEffect,
  stepCandidates,
} from './effectRunner';
import { matchesFilter } from './filters';
import {
  type Action,
  applyAction,
  type Ctx,
  fieldMonsters,
  findLocation,
  getDef,
  isMonsterZone,
  makeEnv,
  type MonsterLocation,
  type SummonMethod,
} from './game';
import { tributesRequired } from './rules';
import type { GameState, Location } from './types';
import { isExtraDeckCard } from './types';

// ルート探索：今の盤面から取れる操作を列挙し、盤面の強さを評価しながらビームサーチで良い展開を探す。

/** 盤面の評価（デッキごとに用意する） */
export interface Evaluator {
  score: (state: GameState, ctx: Ctx) => number;
  /** 最終盤面の説明（妨害の一覧など） */
  describe: (state: GameState, ctx: Ctx) => string[];
}

export interface RouteStep {
  action: Action;
  /** この操作で起きたこと（ログから作る） */
  lines: string[];
}

export interface Route {
  steps: RouteStep[];
  score: number;
  final: GameState;
  summary: string[];
}

export interface SolveOptions {
  beamWidth?: number;
  maxDepth?: number;
  /** 調べる盤面の数の上限（結果が端末の速さに左右されないように時間ではなく数で区切る） */
  maxNodes?: number;
  /** 念のための時間の上限 */
  timeLimitMs?: number;
  maxRoutes?: number;
  /** 進み具合（0〜1） */
  onProgress?: (ratio: number) => void;
}

const MAX_PER_EFFECT = 24;

// ===== 操作の列挙 =====

function combinations<T>(items: T[], k: number, limit = 40): T[][] {
  const out: T[][] = [];
  const rec = (start: number, acc: T[]) => {
    if (out.length >= limit) return;
    if (acc.length === k) {
      out.push(acc);
      return;
    }
    for (let i = start; i < items.length; i++) rec(i + 1, [...acc, items[i]]);
  };
  rec(0, []);
  return out;
}

/** 同じ名前・同じ場所のカードは同じ選択とみなして候補を減らす */
function dedupe(state: GameState, uids: string[]): string[] {
  const seen = new Set<string>();
  return uids.filter((u) => {
    const loc = findLocation(state, u);
    const key = `${state.cards[u].defId}@${loc?.zone ?? 'overlay'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function monsterZonesFor(state: GameState, fromExtra: boolean): MonsterLocation[] {
  const zones: MonsterLocation[] = [];
  if (fromExtra) [0, 1].forEach((i) => !state.emz[i] && zones.push({ zone: 'emz', index: i }));
  [0, 1, 2, 3, 4].forEach((i) => !state.mz[i] && zones.push({ zone: 'mz', index: i }));
  return zones;
}

/** 効果の選択肢を全部たどって、完成した効果処理（BATCH）を列挙する */
function expandEffect(state: GameState, ctx: Ctx, uid: string, effect: Parameters<typeof startEffect>[3]): Action[] {
  const out: Action[] = [];
  const walk = (r: RunResult) => {
    if (out.length >= MAX_PER_EFFECT) return;
    if (r.kind === 'error') return;
    if (r.kind === 'done') {
      out.push(r.action);
      return;
    }
    const run = r.run;
    if (run.stage === 'pick') {
      const [min, max] = pickRange(run, ctx);
      const cands = dedupe(run.temp, stepCandidates(run, ctx));
      const sizes = min === 0 ? [0, Math.min(1, max)] : [min];
      for (const k of [...new Set(sizes)]) {
        for (const picked of k === 0 ? [[]] : combinations(cands, k, 12)) walk(afterPick({ ...run, picked }, ctx));
      }
    } else if (run.stage === 'mode') {
      const step = run.effect.steps[run.stepIndex];
      const modes = step.op === 'pick' ? (step.modes ?? []) : [];
      modes.forEach((_, mode) => walk(afterPick({ ...run, mode }, ctx)));
    } else {
      // ゾーンは空いている最初の場所（EXから出すならEXゾーン優先）で試す
      const fromExtra = findLocation(run.temp, run.picked[0] ?? '')?.zone === 'extra';
      const step = run.effect.steps[run.stepIndex];
      const kind = step.op === 'place' ? step.zone : step.op === 'pick' ? step.zone : undefined;
      const zones: Location[] =
        kind === 'stz'
          ? run.temp.stz.flatMap((u, i) => (u ? [] : [{ zone: 'stz', index: i } as Location]))
          : monsterZonesFor(run.temp, fromExtra);
      for (const z of zones) {
        const next = completeStep(run, ctx, z);
        if (next.kind !== 'error') {
          walk(next);
          break;
        }
      }
    }
  };
  walk(startEffect(state, ctx, uid, effect));
  return out;
}

function cardsInPlay(state: GameState): string[] {
  return [
    ...state.hand,
    ...fieldMonsters(state),
    ...state.stz.filter((u): u is string => !!u),
    ...(state.fz ? [state.fz] : []),
    ...state.gy,
    ...state.banished,
    ...state.extra,
  ];
}

export function enumerateActions(state: GameState, ctx: Ctx): Action[] {
  const actions: Action[] = [];
  const def = (u: string) => getDef(state, ctx, u);
  const toonWorld = makeEnv(state, ctx, '').toonWorld;
  const main = state.phase === 'M1' || state.phase === 'M2';
  if (!main) return actions;

  // カード固有の効果
  const seenEffect = new Set<string>();
  for (const uid of cardsInPlay(state)) {
    const script = ctx.scripts?.[def(uid).id];
    script?.effects?.forEach((effect, i) => {
      if (effect.opponentOnly || !effectAvailable(state, uid, effect)) return;
      const loc = findLocation(state, uid);
      // 手札・墓地の同名カードは1枚分だけ試す
      const key = `${def(uid).id}:${i}:${loc?.zone === 'hand' || loc?.zone === 'gy' ? loc.zone : uid}`;
      if (seenEffect.has(key)) return;
      seenEffect.add(key);
      actions.push(...expandEffect(state, ctx, uid, effect));
    });
  }

  const monsters = fieldMonsters(state);
  const freeMz = state.mz.indexOf(null);

  // 通常召喚（追加の召喚権・リリースなし召喚を含む）
  const grantChoices: { grant?: number; noTributeGrant?: number }[] = [];
  if (!state.normalSummonUsed) grantChoices.push({});
  state.summonGrants.forEach((g, i) => {
    if (g.extraSummon) grantChoices.push({ grant: i });
    if (g.noTribute) {
      if (!state.normalSummonUsed) grantChoices.push({ noTributeGrant: i });
    }
  });
  for (const uid of dedupe(state, state.hand)) {
    const d = def(uid);
    if (d.kind !== 'monster' || isExtraDeckCard(d) || d.frame === 'ritual' || d.cannotNormalSummon) continue;
    for (const g of grantChoices) {
      const grant = g.grant !== undefined ? state.summonGrants[g.grant] : undefined;
      const noTrib = g.noTributeGrant !== undefined ? state.summonGrants[g.noTributeGrant] : undefined;
      if (grant && !matchesFilter(d, grant.filter, toonWorld)) continue;
      if (noTrib && !matchesFilter(d, noTrib.filter, toonWorld)) continue;
      const need = noTrib ? 0 : tributesRequired(d.level ?? 0);
      for (const tributes of need ? combinations(monsters, need, 6) : [[]]) {
        const index = need ? state.mz.indexOf(tributes.find((t) => state.mz.includes(t)) ?? '__') : freeMz;
        const zone = index >= 0 ? index : freeMz;
        if (zone < 0) continue;
        actions.push({ type: 'NORMAL_SUMMON', uid, index: zone, tributes, ...g });
      }
    }
  }

  // カード固有の召喚条件
  for (const uid of dedupe(state, [...state.hand, ...state.extra, ...state.gy])) {
    const script = ctx.scripts?.[def(uid).id];
    script?.procedures?.forEach((proc, i) => {
      const loc = findLocation(state, uid);
      if (!loc || !(proc.summonFrom as string[]).includes(loc.zone)) return;
      const pool = dedupe(
        state,
        proc.from.flatMap((z) => (z === 'monsters' ? monsters : z === 'hand' ? state.hand : z === 'gy' ? state.gy : [])),
      ).filter((u) => u !== uid);
      const sets = proc.from.length === 0 ? [[]] : [1, 2, 3].flatMap((k) => combinations(pool, k, 30));
      for (const materials of sets) {
        const zones = monsterZonesFor(state, loc.zone === 'extra');
        const fieldMat = materials.find((m) => isMonsterZone(findLocation(state, m)));
        const to = (fieldMat ? (findLocation(state, fieldMat) as MonsterLocation) : undefined) ?? zones[0];
        if (to) actions.push({ type: 'PROC_SUMMON', uid, proc: i, materials, to });
      }
    });
  }

  // EXデッキからのリンク・エクシーズ召喚
  const faceUp = monsters.filter((u) => state.cards[u].faceUp);
  for (const uid of dedupe(state, state.extra)) {
    const d = def(uid);
    const method = ({ link: 'link', xyz: 'xyz' } as Partial<Record<string, SummonMethod>>)[d.frame ?? ''];
    if (!method) continue;
    const sizes = method === 'link' ? [1, 2, 3, 4].filter((k) => k <= (d.link ?? 0)) : [d.xyzMaterialCount ?? 2];
    for (const k of sizes) {
      for (const materials of combinations(faceUp, k, 20)) {
        const fieldMat = materials.find((m) => state.mz.includes(m));
        const zones = monsterZonesFor(state, true);
        const candidatesTo: MonsterLocation[] = [
          ...zones.filter((z) => z.zone === 'emz'),
          ...(fieldMat ? [findLocation(state, fieldMat) as MonsterLocation] : []),
          ...zones.filter((z) => z.zone === 'mz'),
        ];
        for (const to of candidatesTo.slice(0, 2)) actions.push({ type: 'PROCEDURE_SUMMON', method, uid, materials, to });
      }
    }
  }

  // 罠のセット（ターンの最後に伏せる想定）
  if (state.stz.includes(null)) {
    for (const uid of dedupe(state, state.hand)) {
      if (def(uid).kind === 'trap') actions.push({ type: 'SET_SPELL_TRAP', uid });
    }
  }
  return actions;
}

// ===== 探索 =====

function signature(state: GameState): string {
  const ids = (us: (string | null)[]) =>
    us
      .filter((u): u is string => !!u)
      .map((u) => state.cards[u].defId + (state.cards[u].faceUp ? '' : '*') + (state.cards[u].overlay.length || ''))
      .sort()
      .join(',');
  return [
    ids(state.hand),
    ids([...state.mz, ...state.emz]),
    ids(state.stz),
    state.fz ? state.cards[state.fz].defId : '',
    ids(state.gy),
    ids(state.banished),
    state.normalSummonUsed ? 'N' : '',
    state.summonGrants.map((g) => g.source).join('+'),
    Object.keys(state.effectUses).sort().join('|'),
  ].join('/');
}

function stepLines(before: GameState, after: GameState): string[] {
  return after.log
    .slice(before.log.length)
    .filter((l) => l.kind !== 'info' && !l.text.startsWith('デッキをシャッフル'))
    .map((l) => l.text);
}

interface Node {
  state: GameState;
  steps: RouteStep[];
  score: number;
}

export function solve(initial: GameState, ctx: Ctx, evaluator: Evaluator, opts: SolveOptions = {}): Route[] {
  const beamWidth = opts.beamWidth ?? 40;
  const maxDepth = opts.maxDepth ?? 20;
  const deadline = Date.now() + (opts.timeLimitMs ?? 30000);
  const maxNodes = opts.maxNodes ?? 3000;
  let nodes = 0;
  const outOfBudget = () => nodes >= maxNodes || Date.now() >= deadline;
  const maxRoutes = opts.maxRoutes ?? 3;
  const strictCtx: Ctx = { ...ctx, options: { ...ctx.options, strict: true } };

  const seen = new Set<string>([signature(initial)]);
  const best: Node[] = [];
  const record = (n: Node) => {
    best.push(n);
    best.sort((a, b) => b.score - a.score || a.steps.length - b.steps.length);
    if (best.length > 60) best.length = 60;
  };
  let frontier: Node[] = [{ state: initial, steps: [], score: evaluator.score(initial, strictCtx) }];
  record(frontier[0]);

  for (let depth = 0; depth < maxDepth && frontier.length && !outOfBudget(); depth++) {
    const next: Node[] = [];
    for (const node of frontier) {
      if (outOfBudget()) break;
      nodes++;
      if (nodes % 50 === 0) opts.onProgress?.(nodes / maxNodes);
      for (const action of enumerateActions(node.state, strictCtx)) {
        const r = applyAction(node.state, action, strictCtx);
        if (!r.ok) continue;
        const sig = signature(r.state);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const child: Node = {
          state: r.state,
          steps: [...node.steps, { action, lines: stepLines(node.state, r.state) }],
          score: evaluator.score(r.state, strictCtx),
        };
        record(child);
        next.push(child);
      }
    }
    // 手札の枚数と通常召喚権を「これからの伸びしろ」として少し加味して残す
    const potential = (n: Node) => n.score + n.state.hand.length * 0.3 + (n.state.normalSummonUsed ? 0 : 1);
    next.sort((a, b) => potential(b) - potential(a));
    frontier = next.slice(0, beamWidth);
  }

  // 最終盤面が違うものを上位から選ぶ（手札から伏せただけの違いは同じ展開とみなす）
  const routes: Route[] = [];
  const finals = new Set<string>();
  const initialHand = new Set(initial.hand);
  for (const n of best) {
    if (n.steps.length === 0) continue;
    const key = boardKey(n.state, initialHand);
    if (finals.has(key)) continue;
    finals.add(key);
    routes.push({ steps: n.steps, score: n.score, final: n.state, summary: evaluator.describe(n.state, strictCtx) });
    if (routes.length >= maxRoutes) break;
  }
  return routes;
}

function boardKey(state: GameState, initialHand: Set<string>): string {
  const ids = (us: (string | null)[]) =>
    us
      .filter((u): u is string => !!u && !initialHand.has(u))
      .map((u) => state.cards[u].defId)
      .sort()
      .join(',');
  return [ids([...state.mz, ...state.emz]), ids(state.stz), state.fz ? state.cards[state.fz].defId : ''].join('/');
}

