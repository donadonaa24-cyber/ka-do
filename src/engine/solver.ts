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
  currentLevel,
  fieldMonsters,
  findLocation,
  getDef,
  isMonsterZone,
  makeEnv,
  type MonsterLocation,
  type SummonMethod,
} from './game';
import { tributesRequired } from './rules';
import type { CardDef, GameState, Location } from './types';
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
  /** 手順の説明（記事のルートなど。無ければログの1行目を見出しにする） */
  note?: string;
}

export interface Route {
  steps: RouteStep[];
  score: number;
  final: GameState;
  summary: string[];
  /** ルートの名前（記事のルートなど） */
  title?: string;
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

export interface EnumerateOptions {
  /** 出すゾーンを全て試す（手順ガイドで決まった配置を再現するため。探索では使わない） */
  allZones?: boolean;
}

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

/**
 * 同じ名前・同じ場所のカードは同じ選択とみなして候補を減らす（keep 枚までは残す。
 * 「青眼の白龍」3体を素材にするなど同名カードを複数選ぶ場合のため）。フィールドのカードは1枚ずつ区別する
 */
function dedupe(state: GameState, uids: string[], keep = 1): string[] {
  const seen = new Map<string, number>();
  return uids.filter((u) => {
    const loc = findLocation(state, u);
    const onField = loc && (loc.zone === 'mz' || loc.zone === 'emz' || loc.zone === 'stz' || loc.zone === 'fz');
    const key = onField ? u : `${state.cards[u].defId}@${loc?.zone ?? 'overlay'}`;
    const n = seen.get(key) ?? 0;
    if (n >= keep) return false;
    seen.set(key, n + 1);
    return true;
  });
}

/**
 * 魔法・罠を置く場所の優先順：自分のモンスターと同じ縦列を避ける
 * （相手の無限泡影など、縦列の魔法・罠をまとめて無効にするカードに巻き込まれないように）
 */
export function preferredStz(state: GameState): number[] {
  const free = [0, 1, 2, 3, 4].filter((i) => !state.stz[i]);
  const shared = (i: number) => !!state.mz[i] || (i === 1 && !!state.emz[0]) || (i === 3 && !!state.emz[1]);
  return [...free.filter((i) => !shared(i)), ...free.filter(shared)];
}

function monsterZonesFor(state: GameState, fromExtra: boolean): MonsterLocation[] {
  const zones: MonsterLocation[] = [];
  if (fromExtra) [0, 1].forEach((i) => !state.emz[i] && zones.push({ zone: 'emz', index: i }));
  [0, 1, 2, 3, 4].forEach((i) => !state.mz[i] && zones.push({ zone: 'mz', index: i }));
  return zones;
}

/** 効果の選択肢を全部たどって、完成した効果処理（BATCH）を列挙する */
function expandEffect(
  state: GameState,
  ctx: Ctx,
  uid: string,
  effect: Parameters<typeof startEffect>[3],
  opts: EnumerateOptions = {},
): Action[] {
  const out: Action[] = [];
  const cap = opts.allZones ? 2000 : MAX_PER_EFFECT;
  const walk = (r: RunResult) => {
    if (out.length >= cap) return;
    if (r.kind === 'error') return;
    if (r.kind === 'done') {
      out.push(r.action);
      return;
    }
    const run = r.run;
    if (run.stage === 'pick') {
      const [min, max] = pickRange(run, ctx);
      let cands = dedupe(run.temp, stepCandidates(run, ctx), Math.max(1, Math.min(max, 3)));
      // 「処理後まで除外」は、カード名の付かない1ターンに1度の効果を使い終えたモンスターにだけ試す（それ以外は得をしない）
      if (run.extraStep) cands = cands.filter((u) => softOncePerTurnUsed(run.temp, ctx, u));
      const step = run.extraStep ?? run.effect.steps[run.stepIndex];
      // 枚数の範囲が盤面で決まる選択（融合素材など）は全ての枚数を試す
      const sizes =
        step.op === 'pick' && step.range
          ? Array.from({ length: Math.max(0, Math.min(max, min + 3) - min + 1) }, (_, i) => min + i)
          : min === 0
            ? [0, Math.min(1, max)]
            : [min];
      for (const k of [...new Set(sizes)]) {
        for (const picked of k === 0 ? [[]] : combinations(cands, k, opts.allZones ? 400 : 12))
          walk(afterPick({ ...run, picked }, ctx));
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
          ? preferredStz(run.temp).map((index): Location => ({ zone: 'stz', index }))
          : monsterZonesFor(run.temp, fromExtra);
      for (const z of zones) {
        const next = completeStep(run, ctx, z);
        if (next.kind !== 'error') {
          walk(next);
          if (!opts.allZones) break;
        }
      }
    }
  };
  // 手札から魔法・罠を発動する場合も、置く場所は縦列を避ける
  const fromHand = findLocation(state, uid)?.zone === 'hand';
  const index = preferredStz(state)[0];
  const activationZone: Location | undefined =
    effect.isCardActivation && fromHand && getDef(state, ctx, uid).spellType !== 'field' && index !== undefined
      ? { zone: 'stz', index }
      : undefined;
  walk(startEffect(state, ctx, uid, effect, activationZone));
  return out;
}

/** カード名の付かない「1ターンに1度」の効果を、今フィールドにいるこのカードで使い終えたか */
function softOncePerTurnUsed(state: GameState, ctx: Ctx, uid: string): boolean {
  const inst = state.cards[uid];
  return (ctx.scripts?.[getDef(state, ctx, uid).id]?.effects ?? []).some(
    (e) => e.perCard && e.key && (state.effectUses[`${e.key}:${uid}:${inst.entryId}`] ?? 0) >= (e.limit ?? 1),
  );
}

/** 素材にしたフィールドのモンスターがいたゾーン（素材が離れた後に空く） */
function materialZones(state: GameState, materials: string[]): MonsterLocation[] {
  return materials.map((m) => findLocation(state, m)).filter((l): l is MonsterLocation => isMonsterZone(l));
}

/** チューナー1体（またはチューナー2体以上＋1体）＋チューナー以外でレベルの合計が合う */
function synchroMaterialsFit(state: GameState, ctx: Ctx, materials: string[], target: CardDef): boolean {
  const tuners = materials.filter((u) => getDef(state, ctx, u).tuner).length;
  const ok = target.multiTunerSynchro ? tuners >= 2 && materials.length - tuners === 1 : tuners === 1;
  if (!ok) return false;
  return materials.reduce((s, u) => s + (currentLevel(state, ctx, u) ?? NaN), 0) === target.level;
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

export function enumerateActions(state: GameState, ctx: Ctx, opts: EnumerateOptions = {}): Action[] {
  const actions: Action[] = [];
  const def = (u: string) => getDef(state, ctx, u);
  const toonWorld = makeEnv(state, ctx, '').toonWorld;
  const main = state.phase === 'M1' || state.phase === 'M2';
  if (!main || state.opponentTurn) return actions;

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
      actions.push(...expandEffect(state, ctx, uid, effect, opts));
    });
  }

  const monsters = fieldMonsters(state);
  const freeMz = state.mz.indexOf(null);

  // 通常召喚（追加の召喚権・リリースなし召喚を含む）
  const grantChoices: { grant?: number; noTributeGrant?: number }[] = [];
  if (!state.normalSummonUsed) grantChoices.push({});
  state.summonGrants.forEach((g, i) => {
    if (g.extraSummon) grantChoices.push({ grant: i });
    // 追加の召喚権とリリースなし召喚を組み合わせる（例：ラハムゥ②＋①）
    if (g.extraSummon)
      state.summonGrants.forEach(
        (h, j) => j !== i && h.noTribute && grantChoices.push({ grant: i, noTributeGrant: j }),
      );
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
        const zones = opts.allZones
          ? [0, 1, 2, 3, 4].filter((i) => !state.mz[i] || tributes.includes(state.mz[i]!))
          : [zone];
        for (const z of zones) actions.push({ type: 'NORMAL_SUMMON', uid, index: z, tributes, ...g });
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
        proc.from.flatMap((z) =>
          z === 'monsters' ? monsters : z === 'hand' ? state.hand : z === 'gy' ? state.gy : [],
        ),
        3,
      ).filter((u) => u !== uid && (!proc.materialFilter || proc.materialFilter(makeEnv(state, ctx, uid), u)));
      const sets =
        proc.from.length === 0 ? [[]] : [1, 2, 3].flatMap((k) => combinations(pool, k, opts.allZones ? 1000 : 30));
      for (const materials of sets) {
        const zones = monsterZonesFor(state, loc.zone === 'extra');
        const fieldMat = materials.find((m) => isMonsterZone(findLocation(state, m)));
        const to = (fieldMat ? (findLocation(state, fieldMat) as MonsterLocation) : undefined) ?? zones[0];
        const tos = opts.allZones ? [...zones, ...materialZones(state, materials)] : to ? [to] : [];
        for (const t of tos) actions.push({ type: 'PROC_SUMMON', uid, proc: i, materials, to: t });
      }
    });
  }

  // EXデッキからのリンク・エクシーズ・シンクロ召喚
  const faceUp = monsters.filter((u) => state.cards[u].faceUp);
  for (const uid of dedupe(state, state.extra)) {
    const d = def(uid);
    const method = ({ link: 'link', xyz: 'xyz', synchro: 'synchro' } as Partial<Record<string, SummonMethod>>)[
      d.frame ?? ''
    ];
    if (!method) continue;
    const sizes =
      method === 'link'
        ? [1, 2, 3, 4].filter((k) => k <= (d.link ?? 0))
        : method === 'xyz'
          ? [d.xyzMaterialCount ?? 2]
          : [2, 3, 4];
    for (const k of sizes) {
      for (const materials of combinations(faceUp, k, 20)) {
        if (method === 'synchro' && !synchroMaterialsFit(state, ctx, materials, d)) continue;
        const fieldMat = materials.find((m) => state.mz.includes(m));
        const zones = monsterZonesFor(state, true);
        const candidatesTo: MonsterLocation[] = opts.allZones
          ? [...zones, ...materialZones(state, materials)]
          : [
              ...zones.filter((z) => z.zone === 'emz'),
              ...(fieldMat ? [findLocation(state, fieldMat) as MonsterLocation] : []),
              ...zones.filter((z) => z.zone === 'mz'),
            ].slice(0, 2);
        for (const to of candidatesTo) actions.push({ type: 'PROCEDURE_SUMMON', method, uid, materials, to });
      }
    }
  }

  // 罠のセット（ターンの最後に伏せる想定）
  if (state.stz.includes(null)) {
    for (const uid of dedupe(state, state.hand)) {
      if (def(uid).kind === 'trap') actions.push({ type: 'SET_SPELL_TRAP', uid, index: preferredStz(state)[0] });
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

export function stepLines(before: GameState, after: GameState): string[] {
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

/**
 * 「処理後まで除外」（完全なる世界③）は選択肢が増えて探索が薄くなるので、
 * 使わない探索と使う探索を両方行い、良いルートを合わせて返す（使える分だけ必ず良くなる）
 */
export function solveBest(initial: GameState, ctx: Ctx, evaluator: Evaluator, opts: SolveOptions = {}): Route[] {
  const scripts = ctx.scripts ?? {};
  const hasTempBanish = Object.values(scripts).some((s) => s.tempBanish);
  if (!hasTempBanish) return solve(initial, ctx, evaluator, opts);
  const plain: Ctx = {
    ...ctx,
    scripts: Object.fromEntries(Object.entries(scripts).map(([id, s]) => [id, { ...s, tempBanish: undefined }])),
  };
  const half = (offset: number) => (ratio: number) => opts.onProgress?.(offset + ratio / 2);
  const a = solve(initial, plain, evaluator, { ...opts, onProgress: half(0) });
  const b = solve(initial, ctx, evaluator, { ...opts, onProgress: half(0.5) });
  const maxRoutes = opts.maxRoutes ?? 3;
  const seen = new Set<string>();
  return [...a, ...b]
    .sort((x, y) => y.score - x.score || x.steps.length - y.steps.length)
    .filter((r) => {
      const key = r.summary.join('\n');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxRoutes);
}
