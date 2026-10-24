import {
  type Action,
  candidates,
  currentLevel,
  currentStats,
  effectSummonError,
  type MonsterLocation,
  oppMonsterSlots,
} from '../engine/game';
import type { CardFilter } from '../engine/filters';
import { linkedZonesOf } from '../engine/rules';
import type { CardScript, EffectDef, Env, PickZone, ProcedureDef, Step } from '../engine/scripts';
import type { CardDef, GameState, Location } from '../engine/types';
import { CYBER_CARD_DATA } from './cyberCards.generated';

// サイバー・ドラゴンデッキのカードの召喚条件・効果。相手がいる時だけ意味がある効果は、記録するだけにする。

const CD = 'サイバー・ドラゴン';
const MACHINE = '機械族';

// ===== 部品 =====

const move = (
  uid: string,
  to: Location,
  reason?: string,
  extra: Partial<Extract<Action, { type: 'MOVE' }>> = {},
): Action => ({ type: 'MOVE', uid, to, reason, ...extra });
const toHand = (uid: string, reason = '効果') => move(uid, { zone: 'hand' }, reason);
const toGy = (uid: string, reason = 'コスト') => move(uid, { zone: 'gy' }, reason);
const ss = (uid: string, zone: Location | null, note: string, position?: 'atk' | 'def'): Action => ({
  type: 'SPECIAL_SUMMON',
  uid,
  to: zone as MonsterLocation,
  position,
  note,
});
const shuffle: Action = { type: 'SHUFFLE_DECK' };
const withShuffle = (env: Env, picked: string[], actions: Action[]): Action[] =>
  picked.some((u) => env.loc(u)?.zone === 'deck') ? [...actions, shuffle] : actions;
const fail = (message: string): Action => ({ type: 'FAIL', message });
/** ターン終了時まで、機械族モンスターしか特殊召喚できない */
const machineLock = (source: string): Action => ({
  type: 'EXTRA_LOCK',
  source,
  filter: { race: [MACHINE] },
  all: true,
});
const firstEmptyStz = (env: Env): Location | null => {
  const i = env.state.stz.indexOf(null);
  return i < 0 ? null : { zone: 'stz', index: i };
};
/** 装備魔法カード扱いで装備する */
const equip = (env: Env, uid: string, to: string, note: string): Action[] => {
  const z = firstEmptyStz(env);
  return z
    ? [move(uid, z, `${env.def(to).name}に装備（${note}）`, { faceUp: true, equipTo: to })]
    : [fail('魔法＆罠ゾーンに空きがありません')];
};

const mainPhase = (env: Env) =>
  !env.state.opponentTurn && (env.state.phase === 'M1' || env.state.phase === 'M2')
    ? null
    : '自分のメインフェイズにのみ発動できます';

const selfTo = (zone: 'gy' | 'banished', reason = 'コスト'): Step => ({
  op: 'do',
  cost: reason === 'コスト',
  then: (env) => [move(env.self, { zone }, reason)],
});
const ssSelf = (note: string, position?: 'atk' | 'def'): Step => ({
  op: 'place',
  prompt: 'このカードを出すゾーンを選択',
  zone: 'monster',
  then: (env, zone) => [ss(env.self, zone, note, position)],
});
const search = (
  prompt: string,
  filter: CardFilter,
  where?: (env: Env, uid: string) => boolean,
  from: PickZone[] = ['deck'],
  min = 1,
): Step => ({
  op: 'pick',
  prompt,
  from,
  filter,
  where,
  min,
  max: 1,
  // 加えなくてもよい（min 0）時は、選ばなければ何もしない
  then: (env, p) =>
    withShuffle(
      env,
      p,
      p.map((u) => toHand(u, from.includes('deck') ? 'サーチ' : '効果')),
    ),
});
const discardCost = (prompt = 'コスト：捨てる手札', where?: (env: Env, uid: string) => boolean): Step => ({
  op: 'pick',
  cost: true,
  prompt,
  from: ['hand'],
  where: (env, u) => u !== env.self && (!where || where(env, u)),
  min: 1,
  max: 1,
  then: (_, p) => p.map((u) => toGy(u)),
});
const lockStep = (source: string): Step => ({ op: 'do', cost: true, then: () => [machineLock(source)] });
/** 対象のモンスターを特殊召喚する（対象は発動時、出すゾーンは解決時に選ぶ） */
const ssTarget = (
  prompt: string,
  from: PickZone[],
  where: (env: Env, uid: string) => boolean,
  note: string,
  opts: { position?: 'atk' | 'def'; negate?: string; zoneFilter?: ZoneFilter } = {},
): Step[] => [
  { op: 'pick', prompt, target: true, from, where, min: 1, max: 1, then: () => [] },
  {
    op: 'place',
    prompt: '対象のモンスターを出すゾーンを選択',
    zone: 'monster',
    zoneFilter: opts.zoneFilter,
    then: (env, z) => {
      const u = env.picks![0][0];
      return [
        ss(u, z, note, opts.position),
        ...(opts.negate ? [{ type: 'NEGATE_CARD', uid: u, by: opts.negate, untilLeave: true } as Action] : []),
      ];
    },
  },
];
type ZoneFilter = (state: GameState, self: string, loc: Location) => boolean;

/** 相手が関わる効果（一人回しでは記録のみ） */
const logOnly = (label: string, from: EffectDef['from'], key?: string): EffectDef => ({
  label,
  from,
  key,
  limit: key ? 1 : undefined,
  opponentOnly: true,
  speed: 2,
  steps: [],
});

// ===== 条件 =====

const onField = (env: Env, u: string) => ['mz', 'emz'].includes(env.loc(u)?.zone ?? '');
const onAnyField = (env: Env, u: string) => ['mz', 'emz', 'omz', 'oemz'].includes(env.loc(u)?.zone ?? '');
const ownMonsters = (env: Env) => [...env.state.mz, ...env.state.emz].filter((u): u is string => !!u);
const ownFaceUpMonsters = (env: Env) => ownMonsters(env).filter((u) => env.state.cards[u].faceUp);
const oppMonsters = (env: Env) => (env.state.opp ? oppMonsterSlots(env.state.opp) : []).filter((u): u is string => !!u);
/** 機械仕掛けの夜①：フィールドの表側表示モンスターは機械族になる */
const clockworkOn = (env: Env) =>
  [...env.state.stz, env.state.fz, ...(env.state.opp?.stz ?? []), env.state.opp?.fz ?? null].some(
    (u) => !!u && env.state.cards[u].faceUp && !!env.def(u).allMachineAura,
  );
const isMachine = (env: Env, u: string) =>
  env.def(u).kind === 'monster' &&
  (env.def(u).race === MACHINE || (onAnyField(env, u) && env.state.cards[u].faceUp && clockworkOn(env)));
/** カード名が「サイバー・ドラゴン」（コア・ネクステア・ヘルツなどはフィールド・墓地にある時だけ） */
const isCDName = (env: Env, u: string) => {
  const d = env.def(u);
  if (d.name === CD) return true;
  const zone = env.loc(u)?.zone ?? '';
  return d.fieldGyName === CD && ['mz', 'emz', 'omz', 'oemz', 'gy'].includes(zone);
};
/** 「サイバー・ドラゴン」モンスター */
const isCDMonster = (env: Env, u: string) =>
  env.def(u).kind === 'monster' && (!!env.def(u).archetypes?.includes(CD) || isCDName(env, u));
const has = (env: Env, u: string, archetype: string) => !!env.def(u).archetypes?.includes(archetype);
/** ドラゴン族・機械族の「サイバー」モンスター */
const isCyberDragonOrMachine = (env: Env, u: string) =>
  env.def(u).kind === 'monster' && has(env, u, 'サイバー') && ['ドラゴン族', MACHINE].includes(env.def(u).race ?? '');
const atkOf = (env: Env, u: string) =>
  onAnyField(env, u) ? (currentStats(env.state, env.ctx, u).atk ?? 0) : (env.def(u).atk ?? 0);
const oppOnlyMonsters = (env: Env) =>
  ownMonsters(env).length
    ? '自分フィールドにモンスターがいると使えません'
    : oppMonsters(env).length
      ? null
      : '相手フィールドにモンスターがいません（相手の盤面を置くと使えます）';
const noOwnMonsters = (env: Env) =>
  ownMonsters(env).length ? '自分フィールドにモンスターがいると特殊召喚できません' : null;
const sentThisTurn = (env: Env) =>
  env.state.cards[env.self].movedTurn === env.state.turn ? null : 'このターンに墓地へ送られていません';
const summonedAs = (how: 'normal' | 'special' | 'fusion' | 'link') => (env: Env) => {
  const t = env.state.cards[env.self].summonType;
  const ok = how === 'special' ? !!t && t !== 'normal' : t === how;
  return ok
    ? null
    : `${{ normal: '召喚', special: '特殊召喚', fusion: '融合召喚', link: 'L召喚' }[how]}した時に発動できます`;
};

/** そのリンクモンスターのリンク先にだけ出す */
const linkedTo =
  (id: string): ZoneFilter =>
  (state, self, loc) => {
    const def: CardDef = CYBER_CARD_DATA.find((c) => c.id === id)!;
    return loc.zone === 'mz' && linkedZonesOf(state, self, def).includes(loc.index);
  };

// ===== 融合 =====

/** 融合モンスターの素材の条件 */
interface FusionRecipe {
  range: [number, number];
  candidate: (env: Env, u: string) => boolean;
  check: (env: Env, m: string[]) => string | null;
}

const FUSION: Record<string, FusionRecipe> = {
  // サイバー・エタニティ・ドラゴン：「サイバー・ドラゴン」モンスター＋機械族モンスター×２
  '82315403': {
    range: [3, 3],
    candidate: (env, u) => isMachine(env, u) || isCDMonster(env, u),
    check: (env, m) =>
      m.length === 3 && m.some((c, i) => isCDMonster(env, c) && m.every((o, j) => j === i || isMachine(env, o)))
        ? null
        : '「サイバー・ドラゴン」モンスター＋機械族モンスター2体が必要です',
  },
  // 終撃竜－サイバー・エンド・ドラゴン：攻撃力2100以上の機械族モンスター×３
  '30275298': {
    range: [3, 3],
    candidate: (env, u) => isMachine(env, u) && atkOf(env, u) >= 2100,
    check: (env, m) =>
      m.length === 3 && m.every((u) => isMachine(env, u) && atkOf(env, u) >= 2100)
        ? null
        : '攻撃力2100以上の機械族モンスター3体が必要です',
  },
  // キメラテック・ランページ・ドラゴン：「サイバー・ドラゴン」モンスター×２体以上
  '84058253': {
    range: [2, 6],
    candidate: isCDMonster,
    check: (env, m) =>
      m.length >= 2 && m.every((u) => isCDMonster(env, u)) ? null : '「サイバー・ドラゴン」モンスター2体以上が必要です',
  },
};
const fusionCheck = (id: string) => (env: Env, m: string[], method: string) =>
  method === 'fusion' ? FUSION[id].check(env, m) : null;

interface FusionOpts {
  by: string;
  from: ('hand' | 'monsters' | 'gy' | 'deck')[];
  /** 融合召喚できる融合モンスター */
  monster: (env: Env, uid: string) => boolean;
  /** 素材の組み合わせの追加の条件 */
  materials?: (env: Env, m: string[]) => string | null;
  /** 融合召喚の後の処理 */
  after?: (env: Env, target: string, m: string[]) => Action[];
}

/** k枚の組み合わせを列挙する（見つかったら true を返して打ち切る） */
const someCombo = (
  items: string[],
  k: number,
  ok: (c: string[]) => boolean,
  start = 0,
  cur: string[] = [],
): boolean => {
  if (cur.length === k) return ok(cur);
  for (let i = start; i <= items.length - (k - cur.length); i++)
    if (someCombo(items, k, ok, i + 1, [...cur, items[i]])) return true;
  return false;
};

const fusionTargetPossible = (env: Env, opts: FusionOpts, t: string): boolean => {
  const recipe = FUSION[env.def(t).id];
  if (!recipe || env.def(t).frame !== 'fusion' || !opts.monster(env, t)) return false;
  if (effectSummonError(env.state, env.ctx, t, 'fusion')) return false;
  const mats = candidates(env.state, opts.from)
    .filter((u) => env.def(u).kind === 'monster' && recipe.candidate(env, u))
    .slice(0, 14);
  for (let k = recipe.range[0]; k <= Math.min(recipe.range[1], mats.length); k++)
    if (someCombo(mats, k, (c) => !recipe.check(env, c) && !opts.materials?.(env, c))) return true;
  return false;
};
const fusionPossible =
  (opts: FusionOpts) =>
  (env: Env): string | null =>
    env.state.extra.some((t) => fusionTargetPossible(env, opts, t))
      ? null
      : '融合召喚できる融合モンスターと素材の組み合わせがありません';

/** 効果による融合召喚：融合モンスターを選び、素材を選ぶ */
const fusionSteps = (opts: FusionOpts | ((env: Env) => FusionOpts)): Step[] => {
  const o = (env: Env) => (typeof opts === 'function' ? opts(env) : opts);
  return [
    {
      op: 'pick',
      prompt: 'EXデッキから融合召喚する融合モンスター',
      from: ['extra'],
      filter: { kind: ['monster'], frame: ['fusion'] },
      where: (env, u) => fusionTargetPossible(env, o(env), u),
      min: 1,
      max: 1,
      then: () => [],
    },
    {
      op: 'pick',
      prompt: '融合素材（墓地へ送る）→ 出すゾーンを選択',
      from: typeof opts === 'function' ? ['hand', 'monsters', 'gy', 'deck'] : opts.from,
      where: (env, u) => {
        const target = env.picks?.[0]?.[0];
        const zone = env.loc(u)?.zone ?? '';
        const allowed = o(env).from.some((f) => (f === 'monsters' ? ['mz', 'emz'].includes(zone) : f === zone));
        return !!target && allowed && env.def(u).kind === 'monster' && FUSION[env.def(target).id].candidate(env, u);
      },
      range: (env) => {
        const target = env.picks?.[0]?.[0];
        return target ? FUSION[env.def(target).id].range : [1, 1];
      },
      zone: 'monster',
      noSummonCheck: true,
      then: (env, p, z) => {
        const opt = o(env);
        const target = env.picks![0][0];
        const err = FUSION[env.def(target).id].check(env, p) ?? opt.materials?.(env, p);
        if (err) return [fail(err)];
        return [
          {
            type: 'PROCEDURE_SUMMON',
            method: 'fusion',
            uid: target,
            materials: p,
            to: z as MonsterLocation,
            materialZones: opt.from.map((f) => (f === 'monsters' ? 'field' : f)),
            by: opt.by,
          },
          ...(p.some((u) => env.loc(u)?.zone === 'deck') ? [shuffle] : []),
          ...(opt.after?.(env, target, p) ?? []),
        ];
      },
    },
  ];
};

const machineFusion = (env: Env, u: string) => env.def(u).race === MACHINE;

/** サイバー・ダーク・キメラ①を使ったターン：パワー・ボンドの素材は「サイバー」だけ・墓地のモンスターを1体除外して使える */
const chimeraUsed = (env: Env) => !!env.state.effectUses['サイバー・ダーク・キメラ①'];
const POWER_BOND = (env: Env): FusionOpts => ({
  by: 'パワー・ボンド',
  from: chimeraUsed(env) ? ['hand', 'monsters', 'gy'] : ['hand', 'monsters'],
  monster: machineFusion,
  materials: (e, m) => {
    if (!chimeraUsed(e)) return null;
    if (!m.every((u) => isCyberDragonOrMachine(e, u)))
      return 'サイバー・ダーク・キメラの効果で、ドラゴン族・機械族の「サイバー」モンスターしか融合素材にできません';
    return m.filter((u) => e.loc(u)?.zone === 'gy').length > 1 ? '墓地のモンスターは1体まで素材にできます' : null;
  },
  after: (e, target, m) => {
    const up = e.def(target).atk ?? 0;
    return [
      // キメラの効果で墓地から素材にしたモンスターは除外
      ...m
        .filter((u) => e.loc(u)?.zone === 'gy')
        .map((u) => move(u, { zone: 'banished' }, 'サイバー・ダーク・キメラの効果')),
      { type: 'STAT_MOD', uid: target, atk: up, source: 'パワー・ボンド' },
      { type: 'DAMAGE_AT_END', amount: up, by: 'パワー・ボンド' },
    ];
  },
});
const FUTURE_NOVA: FusionOpts = {
  by: '未来融合－フューチャー・フュージョン・ノヴァ',
  from: ['deck'],
  monster: (env, u) => env.def(u).race === MACHINE && env.def(u).attribute === '光',
  materials: (env, m) =>
    m.some((u) => env.def(u).name === CD) ? null : '「サイバー・ドラゴン」を融合素材に含めてください',
};
const KIKORYU: FusionOpts = {
  by: '機光竜－サイバー・ドラゴン',
  from: ['hand', 'monsters'],
  monster: machineFusion,
  materials: (env, m) => (m.includes(env.self) ? null : 'このカードを融合素材に含めてください'),
};

// ===== 召喚条件 =====

const handProcedure = (label: string, validate: ProcedureDef['validate'], oncePerTurn = false): ProcedureDef => ({
  label,
  hint: '出すゾーンを選択',
  from: [],
  materialsTo: 'gy',
  summonFrom: ['hand'],
  oncePerTurn,
  validate,
});
/** キメラテック・メガフリート・ドラゴン／フォートレス・ドラゴン：自分・相手フィールドのカードを墓地へ送って特殊召喚 */
const contactFusion = (label: string, per: number, validate: ProcedureDef['validate']): ProcedureDef => ({
  label,
  hint: '素材にする自分・相手フィールドのモンスターを選んで「決定」→ 出すゾーン',
  from: ['monsters', 'oppMonsters'],
  materialsTo: 'gy',
  materialsReason: '素材',
  summonFrom: ['extra'],
  validate: (env, m) => {
    if (m.some((u) => !env.state.cards[u].faceUp)) return '表側表示のモンスターを選んでください';
    return validate(env, m);
  },
  after: (env, m) => [{ type: 'STAT_MOD', uid: env.self, setAtk: m.length * per }],
});

// ===== カードの見た目以外の性質 =====

export const CYBER_OVERRIDES: Record<string, Partial<CardDef>> = {
  // フィールド・墓地では「サイバー・ドラゴン」として扱う
  '56100345': { fieldGyName: CD },
  '23893227': { fieldGyName: CD },
  '1142880': { fieldGyName: CD },
  '56364287': { fieldGyName: CD },
  '46724542': { fieldGyName: CD },
  // 機械仕掛けの夜：フィールドの表側表示モンスターは機械族、自分の機械族は500アップ・相手は500ダウン
  '84797028': { allMachineAura: 500, oncePerTurnActivation: true },
  // このカード名のカードは1ターンに1枚しか発動できない
  '89693655': { oncePerTurnActivation: true },
  '92058902': { oncePerTurnActivation: true },
  '64753988': { oncePerTurnActivation: true },
  '63031396': { oncePerTurnActivation: true },
  '60600126': { oncePerTurnActivation: true },
  // サイバー・ドラゴン・インフィニティ①：X素材の数×200アップ
  '10443957': { atkPerOverlay: 200 },
  // 終撃竜－サイバー・エンド・ドラゴン：融合召喚でしか特殊召喚できない・②貫通
  '30275298': { onlyBy: 'fusion', piercing: true },
  // 閃刀姫－アザレア：L召喚でしか特殊召喚できない
  '98462037': { onlyBy: 'link' },
};

// ===== カードごとの召喚条件・効果 =====

export const CYBER_SCRIPTS: Record<string, CardScript> = {
  // リミッター解除
  '23171610': {
    effects: [
      {
        label: '発動：自分の機械族モンスターの攻撃力をターン終了時まで倍にする（エンドフェイズに破壊）',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: (env) =>
          ownFaceUpMonsters(env).some((u) => isMachine(env, u)) ? null : '自分フィールドに機械族モンスターがいません',
        steps: [
          {
            op: 'do',
            then: (env) =>
              ownFaceUpMonsters(env)
                .filter((u) => isMachine(env, u))
                .flatMap((u) => [
                  {
                    type: 'STAT_MOD',
                    uid: u,
                    atk: currentStats(env.state, env.ctx, u).atk ?? 0,
                    untilEnd: true,
                    source: 'リミッター解除',
                  } as Action,
                  { type: 'DESTROY_AT_END', uid: u } as Action,
                ]),
          },
        ],
      },
    ],
  },

  // 大嵐
  '19613556': {
    effects: [
      {
        label: '発動：フィールドの魔法・罠カードを全て破壊',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'do',
            then: (env) =>
              [...env.state.stz, env.state.fz, ...(env.state.opp?.stz ?? []), env.state.opp?.fz ?? null]
                .filter((u): u is string => !!u && u !== env.self)
                .map((u) => toGy(u, '効果で破壊')),
          },
        ],
      },
    ],
  },

  // 亜空間バトル（相手のデッキは無いので、比べた結果は自分で選ぶ）
  '89693655': {
    effects: [
      {
        label: '発動：デッキのモンスターを相手と見せ合う（3回。結果は相手のモンスターと比べて選ぶ）',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [1, 2, 3].map(
          (n): Step => ({
            op: 'pick',
            prompt: `${n}回目：デッキから選ぶ攻撃力？以外のモンスター（相手のモンスターと比べた結果を次に選ぶ）`,
            from: ['deck'],
            where: (env, u) => env.def(u).kind === 'monster' && env.def(u).atk !== undefined && env.def(u).atk! >= 0,
            min: 0,
            max: 1,
            modes: ['攻撃力が高い：手札に加える', '攻撃力が低い：破壊して500ダメージ', '同じ：デッキに戻す'],
            then: (env, p, _, mode) =>
              p.flatMap((u) =>
                mode === 0
                  ? withShuffle(env, p, [toHand(u)])
                  : mode === 1
                    ? withShuffle(env, p, [toGy(u, '効果で破壊'), { type: 'CHANGE_LP', delta: -500 } as Action])
                    : [],
              ),
          }),
        ),
      },
    ],
  },

  // 未来融合－フューチャー・フュージョン・ノヴァ
  '92058902': {
    effects: [
      {
        label: '発動：「サイバー・ドラゴン」を含むデッキのモンスターで機械族・光属性の融合モンスターを融合召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: fusionPossible(FUTURE_NOVA),
        steps: [lockStep('未来融合－フューチャー・フュージョン・ノヴァ'), ...fusionSteps(FUTURE_NOVA)],
      },
    ],
  },

  // サイバーダーク・ワールド（③は相手の墓地を使う効果なので記録しない）
  '64753988': {
    effects: [
      {
        label: '発動：同名カードが墓地に無い「サイバー・ダーク」モンスターをデッキから手札に加えられる',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          search(
            '手札に加える「サイバー・ダーク」モンスター（加えなくてもよい）',
            { kind: ['monster'], archetype: 'サイバー・ダーク' },
            (env, u) => !env.state.gy.some((g) => env.def(g).name === env.def(u).name),
            ['deck'],
            0,
          ),
        ],
      },
      {
        label: '② 「サイバー・ダーク」モンスター1体の召喚を行う（追加の召喚）',
        from: ['spelltrap'],
        key: 'サイバーダーク・ワールド②',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'do',
            then: () => [
              {
                type: 'GRANT_SUMMON',
                grant: {
                  source: 'サイバーダーク・ワールド',
                  extraSummon: true,
                  noTribute: false,
                  filter: { kind: ['monster'], archetype: 'サイバー・ダーク' },
                  thisTurnOnly: true,
                },
              },
            ],
          },
        ],
      },
    ],
  },

  // サイバネティック・ホライゾン
  '63031396': {
    effects: [
      {
        label: '発動：手札・デッキの「サイバー」を墓地へ送り、「サイバー」をサーチ・EXの「サイバー」融合を墓地へ',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'do',
            cost: true,
            then: () => [{ type: 'EXTRA_LOCK', source: 'サイバネティック・ホライゾン', filter: { race: [MACHINE] } }],
          },
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：墓地へ送る手札のドラゴン族・機械族の「サイバー」モンスター',
            from: ['hand'],
            where: isCyberDragonOrMachine,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u)),
          },
          {
            op: 'pick',
            cost: true,
            prompt:
              'コスト：墓地へ送るデッキのドラゴン族・機械族の「サイバー」モンスター（手札から送ったものと違う属性）',
            from: ['deck'],
            where: (env, u) =>
              isCyberDragonOrMachine(env, u) && env.def(u).attribute !== env.def(env.picks![0][0]).attribute,
            min: 1,
            max: 1,
            then: (env, p) =>
              withShuffle(
                env,
                p,
                p.map((u) => toGy(u)),
              ),
          },
          search(
            'デッキから手札に加えるドラゴン族・機械族の「サイバー」モンスター',
            { kind: ['monster'] },
            isCyberDragonOrMachine,
          ),
          {
            op: 'pick',
            prompt: 'EXデッキから墓地へ送る機械族の「サイバー」融合モンスター',
            from: ['extra'],
            where: (env, u) => env.def(u).frame === 'fusion' && env.def(u).race === MACHINE && has(env, u, 'サイバー'),
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '効果')),
          },
        ],
      },
    ],
  },

  // エマージェンシー・サイバー
  '60600126': {
    effects: [
      {
        label: '① デッキから「サイバー・ドラゴン」モンスターか通常召喚できない機械族・光属性モンスターを手札に加える',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          search(
            'デッキから手札に加える「サイバー・ドラゴン」モンスターか通常召喚できない機械族・光属性モンスター',
            { kind: ['monster'] },
            (env, u) =>
              has(env, u, CD) ||
              (!!env.def(u).cannotNormalSummon && env.def(u).race === MACHINE && env.def(u).attribute === '光'),
          ),
        ],
      },
      logOnly('② 相手に発動を無効にされた場合、手札を1枚捨てて手札に加える（相手用）', ['gy']),
    ],
  },

  // パワー・ボンド
  '37630732': {
    effects: [
      {
        label: '発動：手札・フィールドで機械族の融合モンスターを融合召喚（攻撃力が倍・エンドフェイズにダメージ）',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: (env) => fusionPossible(POWER_BOND(env))(env),
        steps: fusionSteps(POWER_BOND),
      },
    ],
  },

  // 機械仕掛けの夜－クロック・ワーク・ナイト－（①②は表側で存在する限り適用）
  '84797028': {
    effects: [
      { label: '発動', from: ['hand', 'spelltrap'], isCardActivation: true, steps: [] },
      {
        label: '③ 墓地から除外し手札を1枚捨て、デッキから機械族・地属性モンスターを手札に加える',
        from: ['gy'],
        key: '機械仕掛けの夜－クロック・ワーク・ナイト－③',
        limit: 1,
        steps: [
          selfTo('banished'),
          discardCost(),
          search('デッキから手札に加える機械族・地属性モンスター', {
            kind: ['monster'],
            race: [MACHINE],
            attribute: ['地'],
          }),
        ],
      },
    ],
  },

  // セリオンズ“キング”レギュラス
  '10604644': {
    effects: [
      {
        label: '① 墓地の「セリオンズ」か機械族を対象に、手札から特殊召喚して装備',
        from: ['hand'],
        key: 'セリオンズ“キング”レギュラス①',
        limit: 1,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: '装備する自分の墓地の「セリオンズ」モンスターか機械族モンスター（対象）',
            target: true,
            from: ['gy'],
            where: (env, u) =>
              env.def(u).kind === 'monster' && (has(env, u, 'セリオンズ') || env.def(u).race === MACHINE),
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'place',
            prompt: 'このカードを出すゾーンを選択',
            zone: 'monster',
            then: (env, z) => [
              ss(env.self, z, '自身の効果'),
              ...equip(env, env.picks![0][0], env.self, '装備魔法カード扱い'),
            ],
          },
        ],
      },
      logOnly(
        '② 相手の効果の発動時、「セリオンズ」を墓地へ送って無効（相手用）',
        ['monster'],
        'セリオンズ“キング”レギュラス②',
      ),
    ],
  },

  // サイバー・ダーク・ヴルム
  '56100345': {
    effects: [
      {
        label:
          '② 「サイバー・ドラゴン」モンスターを墓地へ送り特殊召喚、墓地の「サイバー」魔法・罠を回収（デュエル中1度）',
        from: ['hand', 'gy'],
        key: 'duel:サイバー・ダーク・ヴルム②',
        limit: 1,
        condition: (env) =>
          [...ownMonsters(env), ...env.state.gy].some(
            (u) => u !== env.self && has(env, u, 'サイバー') && isMachine(env, u),
          )
            ? null
            : '自分のフィールドか墓地に、このカード以外の機械族の「サイバー」モンスターが必要です',
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：墓地へ送る手札・デッキの「サイバー・ドラゴン」モンスター',
            from: ['hand', 'deck'],
            where: (env, u) => u !== env.self && isCDMonster(env, u),
            min: 1,
            max: 1,
            then: (env, p) =>
              withShuffle(
                env,
                p,
                p.map((u) => toGy(u)),
              ),
          },
          ssSelf('自身の効果'),
          search(
            '墓地から手札に加える「サイバー」か「サイバネティック」魔法・罠カード（加えなくてもよい）',
            { kind: ['spell', 'trap'] },
            (env, u) => has(env, u, 'サイバー') || has(env, u, 'サイバネティック'),
            ['gy'],
            0,
          ),
        ],
      },
    ],
  },

  // サイバー・ドラゴン・コア
  '23893227': {
    effects: [
      {
        label: '② 召喚した場合：デッキから「サイバー」か「サイバネティック」魔法・罠を手札に加える',
        from: ['monster'],
        key: 'サイバー・ドラゴン・コア②③',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: summonedAs('normal'),
        steps: [
          search(
            'デッキから手札に加える「サイバー」か「サイバネティック」魔法・罠カード',
            { kind: ['spell', 'trap'] },
            (env, u) => has(env, u, 'サイバー') || has(env, u, 'サイバネティック'),
          ),
        ],
      },
      {
        label:
          '③ 相手フィールドにのみモンスターがいる時、墓地から除外：デッキから「サイバー・ドラゴン」モンスターを特殊召喚',
        from: ['gy'],
        key: 'サイバー・ドラゴン・コア②③',
        limit: 1,
        speed: 2,
        condition: oppOnlyMonsters,
        steps: [
          selfTo('banished'),
          {
            op: 'pick',
            prompt: 'デッキから特殊召喚する「サイバー・ドラゴン」モンスター',
            from: ['deck'],
            where: (env, u) => has(env, u, CD) && env.def(u).kind === 'monster',
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, 'サイバー・ドラゴン・コアの効果')]),
          },
        ],
      },
    ],
  },

  // サイバー・ダーク・クロー
  '82562802': {
    effects: [
      {
        label: '① 手札から捨てて、デッキから「サイバーダーク」魔法・罠を手札に加える',
        from: ['hand'],
        key: 'サイバー・ダーク・クロー①',
        limit: 1,
        steps: [
          selfTo('gy'),
          search('デッキから手札に加える「サイバーダーク」魔法・罠カード', {
            kind: ['spell', 'trap'],
            archetype: 'サイバーダーク',
          }),
        ],
      },
      logOnly(
        '② 装備したモンスターの戦闘のダメージ計算時、EXデッキのモンスターを墓地へ（相手用）',
        ['spelltrap'],
        'サイバー・ダーク・クロー②',
      ),
      {
        label: '③ 装備されていたこのカードが墓地へ送られた場合：墓地の「サイバー・ダーク」モンスターを手札に加える',
        from: ['gy'],
        trigger: true,
        targets: true,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          return inst.movedTurn === env.state.turn && inst.movedFrom === 'stz'
            ? null
            : '装備されていたこのカードが墓地へ送られた時に発動できます';
        },
        steps: [
          {
            op: 'pick',
            prompt: '手札に加える自分の墓地の「サイバー・ダーク」モンスター（対象）',
            target: true,
            from: ['gy'],
            where: (env, u) => u !== env.self && has(env, u, 'サイバー・ダーク') && env.def(u).kind === 'monster',
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toHand(u)),
          },
        ],
      },
    ],
  },

  // サイバー・ダーク・キメラ
  '5370235': {
    effects: [
      {
        label:
          '① 手札の魔法・罠を捨て、デッキから「パワー・ボンド」を手札に加える（このターンの融合素材は「サイバー」だけ）',
        from: ['monster'],
        key: 'サイバー・ダーク・キメラ①',
        limit: 1,
        steps: [
          discardCost('コスト：捨てる手札の魔法・罠カード', (env, u) => env.def(u).kind !== 'monster'),
          search('デッキから手札に加える「パワー・ボンド」', { name: ['パワー・ボンド'] }),
        ],
      },
      {
        label: '② 墓地へ送られた場合：同名カードが墓地に無い「サイバー・ダーク」モンスターをデッキから墓地へ',
        from: ['gy'],
        key: 'サイバー・ダーク・キメラ②',
        limit: 1,
        trigger: true,
        condition: sentThisTurn,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから墓地へ送る「サイバー・ダーク」モンスター（同名カードが墓地に無いもの）',
            from: ['deck'],
            where: (env, u) =>
              has(env, u, 'サイバー・ダーク') &&
              env.def(u).kind === 'monster' &&
              !env.state.gy.some((g) => env.def(g).name === env.def(u).name),
            min: 1,
            max: 1,
            then: (env, p) =>
              withShuffle(
                env,
                p,
                p.map((u) => toGy(u, '効果')),
              ),
          },
        ],
      },
    ],
  },

  // サイバー・ヨルムンガンド
  '19715246': {
    effects: [
      {
        label:
          '① 相手フィールドにモンスターがいる時：手札から特殊召喚し、デッキの「サイバー・ドラゴン」を特殊召喚か装備',
        from: ['hand'],
        key: 'サイバー・ヨルムンガンド①',
        limit: 1,
        condition: (env) =>
          oppMonsters(env).length ? null : '相手フィールドにモンスターがいません（相手の盤面を置くと使えます）',
        steps: [
          ssSelf('自身の効果'),
          {
            op: 'pick',
            prompt: 'デッキの「サイバー・ドラゴン」→ 特殊召喚するか装備するか選ぶ',
            from: ['deck'],
            filter: { name: [CD] },
            min: 1,
            max: 1,
            modes: ['特殊召喚する', 'このカードに装備する'],
            zone: 'monster',
            zoneIf: (_, __, mode) => mode === 0,
            then: (env, p, z, mode) =>
              withShuffle(
                env,
                p,
                mode === 0
                  ? [ss(p[0], z, 'サイバー・ヨルムンガンドの効果')]
                  : equip(env, p[0], env.self, '装備魔法カード扱い'),
              ),
          },
          { op: 'do', then: () => [machineLock('サイバー・ヨルムンガンド')] },
        ],
      },
      {
        label: '② 自分の「サイバー・ドラゴン」を手札に戻し、デッキ・墓地から「融合」を手札に加える',
        from: ['monster'],
        key: 'サイバー・ヨルムンガンド②',
        limit: 1,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：手札に戻す自分フィールドの「サイバー・ドラゴン」',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && isCDName(env, u),
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toHand(u, 'コスト')),
          },
          search('手札に加える「融合」（デッキ・墓地）', { name: ['融合'] }, undefined, ['deck', 'gy']),
        ],
      },
    ],
  },

  // 機光竜－サイバー・ドラゴン
  '66664203': {
    procedures: [handProcedure('① 自分フィールドにモンスターがいない時、手札から特殊召喚', noOwnMonsters)],
    effects: [
      {
        label: '② 特殊召喚した場合：相手の表側表示モンスター1体の効果をターン終了時まで無効',
        from: ['monster'],
        key: '機光竜－サイバー・ドラゴン②',
        limit: 1,
        onSummon: true,
        trigger: true,
        targets: true,
        condition: (env) =>
          summonedAs('special')(env) ??
          (oppMonsters(env).some((u) => env.state.cards[u].faceUp)
            ? null
            : '相手フィールドに表側表示のモンスターがいません'),
        steps: [
          {
            op: 'pick',
            prompt: '効果を無効にする相手の表側表示モンスター（対象）',
            target: true,
            from: ['oppMonsters'],
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => ({ type: 'NEGATE_CARD', uid: u, by: '機光竜－サイバー・ドラゴン' }) as Action),
          },
        ],
      },
      {
        label: '③ このカードを含む手札・フィールドのモンスターで機械族の融合モンスターを融合召喚',
        from: ['monster'],
        key: '機光竜－サイバー・ドラゴン③',
        limit: 1,
        condition: (env) => mainPhase(env) ?? fusionPossible(KIKORYU)(env),
        steps: fusionSteps(KIKORYU),
      },
    ],
  },

  // サイバー・ドラゴン・ネクステア
  '1142880': {
    effects: [
      {
        label: '② 手札の他のモンスターを捨て、このカードを手札から特殊召喚',
        from: ['hand'],
        key: 'サイバー・ドラゴン・ネクステア②',
        limit: 1,
        steps: [
          discardCost('コスト：捨てる手札のモンスター', (env, u) => env.def(u).kind === 'monster'),
          ssSelf('自身の効果'),
        ],
      },
      {
        label:
          '③ 召喚・特殊召喚した場合：墓地の攻撃力か守備力が2100の機械族を特殊召喚（このターン機械族しか特殊召喚できない）',
        from: ['monster'],
        key: 'サイバー・ドラゴン・ネクステア③',
        limit: 1,
        onSummon: true,
        trigger: true,
        targets: true,
        steps: [
          lockStep('サイバー・ドラゴン・ネクステア'),
          ...ssTarget(
            '特殊召喚する自分の墓地の攻撃力か守備力が2100の機械族モンスター（対象）',
            ['gy'],
            (env, u) => env.def(u).race === MACHINE && (env.def(u).atk === 2100 || env.def(u).def === 2100),
            'サイバー・ドラゴン・ネクステアの効果',
          ),
        ],
      },
    ],
  },

  // サイバー・ドラゴン
  '70095154': {
    procedures: [handProcedure('① 相手フィールドにのみモンスターがいる時、手札から特殊召喚', oppOnlyMonsters)],
  },

  // 壊星壊獣ジズキエル
  '63941210': {
    procedures: [
      handProcedure('② 相手フィールドに「壊獣」がいる時、手札から攻撃表示で特殊召喚', (env) =>
        oppMonsters(env).some((u) => env.state.cards[u].faceUp && has(env, u, '壊獣'))
          ? null
          : '相手フィールドに「壊獣」モンスターがいません',
      ),
    ],
    effects: [
      logOnly('① 相手のモンスター1体をリリースし、相手フィールドに特殊召喚（相手用）', ['hand']),
      logOnly('④ カード1枚を対象とする効果の発動時、壊獣カウンター3つで無効（相手用）', ['monster']),
    ],
  },

  // サイバー・ドラゴン・ヘルツ（②③はいずれか1つ）
  '56364287': {
    effects: [
      {
        label:
          '② 特殊召喚した場合：このカードのレベルをターン終了時まで5にする（このターン機械族しか特殊召喚できない）',
        from: ['monster'],
        key: 'サイバー・ドラゴン・ヘルツ②③',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: summonedAs('special'),
        steps: [
          lockStep('サイバー・ドラゴン・ヘルツ'),
          {
            op: 'do',
            then: (env) => [
              {
                type: 'LEVEL_MOD',
                uid: env.self,
                delta: 5 - (currentLevel(env.state, env.ctx, env.self) ?? 5),
                untilEnd: true,
              },
            ],
          },
        ],
      },
      {
        label: '③ 墓地へ送られた場合：デッキ・墓地から「サイバー・ドラゴン」を手札に加える',
        from: ['gy'],
        key: 'サイバー・ドラゴン・ヘルツ②③',
        limit: 1,
        trigger: true,
        condition: sentThisTurn,
        steps: [
          search(
            '手札に加える「サイバー・ドラゴン」（デッキ・墓地）',
            { kind: ['monster'] },
            (env, u) => u !== env.self && isCDName(env, u),
            ['deck', 'gy'],
          ),
        ],
      },
    ],
  },

  // ===== EXデッキ =====

  // プラチナ・ガジェット
  '40216089': {
    materialCheck: (env, m, method) =>
      method !== 'link' || (m.length === 2 && m.every((u) => isMachine(env, u)))
        ? null
        : '機械族モンスター2体が必要です',
    effects: [
      {
        label: '① 手札からレベル4以下の機械族モンスターをリンク先に特殊召喚',
        from: ['monster'],
        key: 'プラチナ・ガジェット①',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            prompt: 'リンク先に特殊召喚する手札のレベル4以下の機械族モンスター',
            from: ['hand'],
            filter: { kind: ['monster'], race: [MACHINE], maxLevel: 4 },
            min: 1,
            max: 1,
            zone: 'monster',
            zoneFilter: linkedTo('40216089'),
            then: (_, p, z) => [ss(p[0], z, 'プラチナ・ガジェットの効果')],
          },
        ],
      },
      {
        label: '② 戦闘・効果で破壊された場合：デッキからレベル4の「ガジェット」を特殊召喚',
        from: ['gy'],
        key: 'プラチナ・ガジェット②',
        limit: 1,
        trigger: true,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          return inst.movedTurn === env.state.turn && (inst.movedReason ?? '').includes('破壊')
            ? null
            : 'このターンに破壊されていません';
        },
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから特殊召喚するレベル4の「ガジェット」モンスター',
            from: ['deck'],
            filter: { kind: ['monster'], archetype: 'ガジェット', minLevel: 4, maxLevel: 4 },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, 'プラチナ・ガジェットの効果')]),
          },
        ],
      },
    ],
  },

  // サイバー・ドラゴン・ズィーガー
  '46724542': {
    materialCheck: (env, m, method) =>
      method !== 'link' || (m.length === 2 && m.every((u) => isMachine(env, u)) && m.some((u) => isCDName(env, u)))
        ? null
        : '「サイバー・ドラゴン」を含む機械族モンスター2体が必要です',
    effects: [
      {
        label:
          '② バトルフェイズ：攻撃力2100以上の機械族1体の攻守をターン終了時まで2100アップ（このカードの戦闘ダメージは0）',
        from: ['monster'],
        key: 'サイバー・ドラゴン・ズィーガー②',
        limit: 1,
        speed: 2,
        damageStep: true,
        targets: true,
        condition: (env) =>
          env.state.phase !== 'BP'
            ? 'バトルフェイズに発動できます'
            : env.state.cards[env.self].attackedTurn === env.state.turn
              ? 'このカードが攻撃宣言をしたターンは発動できません'
              : null,
        steps: [
          {
            op: 'pick',
            prompt: '攻守を上げる自分フィールドの攻撃力2100以上の機械族モンスター（対象）',
            target: true,
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && isMachine(env, u) && atkOf(env, u) >= 2100,
            min: 1,
            max: 1,
            then: (_, p) =>
              p.map(
                (u) =>
                  ({
                    type: 'STAT_MOD',
                    uid: u,
                    atk: 2100,
                    def: 2100,
                    untilEnd: true,
                    source: 'サイバー・ドラゴン・ズィーガー',
                  }) as Action,
              ),
          },
        ],
      },
    ],
  },

  // サイバー・ドラゴン・インフィニティ（①：X素材の数×200アップ）
  '10443957': {
    materialCheck: (env, m, method) =>
      method !== 'xyz' || m.every((u) => isMachine(env, u) && env.def(u).attribute === '光')
        ? null
        : '機械族・光属性のモンスターを選んでください',
    procedures: [
      {
        label: '自分フィールドの「サイバー・ドラゴン・ノヴァ」の上に重ねてX召喚（1ターンに1度）',
        hint: '重ねる「サイバー・ドラゴン・ノヴァ」を選んで「決定」→ 出すゾーン',
        from: ['monsters'],
        materialsTo: 'overlay',
        summonFrom: ['extra'],
        summonType: 'xyz',
        oncePerTurn: true,
        validate: (env, m) =>
          m.length === 1 && env.def(m[0]).name === 'サイバー・ドラゴン・ノヴァ' && env.state.cards[m[0]].faceUp
            ? null
            : '自分フィールドの表側表示の「サイバー・ドラゴン・ノヴァ」1体を選んでください',
      },
    ],
    effects: [
      {
        label: '② フィールドの表側攻撃表示モンスター1体をこのカードのX素材にする',
        from: ['monster'],
        key: 'サイバー・ドラゴン・インフィニティ②',
        limit: 1,
        perCard: true,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: 'X素材にするフィールドの表側攻撃表示モンスター（対象）',
            target: true,
            from: ['monsters', 'oppMonsters'],
            where: (env, u) => u !== env.self && env.state.cards[u].faceUp && env.state.cards[u].position === 'atk',
            min: 1,
            max: 1,
            then: (env, p) => p.map((u) => ({ type: 'ATTACH', uid: u, target: env.self }) as Action),
          },
        ],
      },
      logOnly(
        '③ 効果の発動時、X素材を1つ取り除いて無効にし破壊（相手用）',
        ['monster'],
        'サイバー・ドラゴン・インフィニティ③',
      ),
    ],
  },

  // キメラテック・メガフリート・ドラゴン
  '87116928': {
    procedures: [
      contactFusion(
        '「サイバー・ドラゴン」モンスター＋EXモンスターゾーンのモンスターを墓地へ送って特殊召喚（攻撃力は素材の数×1200）',
        1200,
        (env, m) => {
          const inEmz = (u: string) => ['emz', 'oemz'].includes(env.loc(u)?.zone ?? '');
          return m.length >= 2 && m.some((c, i) => isCDMonster(env, c) && m.every((o, j) => j === i || inEmz(o)))
            ? null
            : '「サイバー・ドラゴン」モンスター1体と、EXモンスターゾーンのモンスター1体以上を選んでください';
        },
      ),
    ],
  },

  // 先史遺産ヴィマナ
  '2609443': {
    effects: [
      {
        label:
          '① フィールドのモンスターの攻撃力を墓地の「先史遺産」かXモンスターの攻撃力の半分アップし、そのモンスターを素材にする',
        from: ['monster'],
        key: '先史遺産ヴィマナ①',
        limit: 1,
        perCard: true,
        speed: 2,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: '攻撃力を上げるフィールドの表側表示モンスター（対象）',
            target: true,
            from: ['monsters', 'oppMonsters'],
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: 'X素材にする自分の墓地の「先史遺産」モンスターかXモンスター（対象）',
            target: true,
            from: ['gy'],
            where: (env, u) => env.def(u).kind === 'monster' && (has(env, u, '先史遺産') || env.def(u).frame === 'xyz'),
            min: 1,
            max: 1,
            then: (env, p) => [
              {
                type: 'STAT_MOD',
                uid: env.picks![0][0],
                atk: Math.floor((env.def(p[0]).atk ?? 0) / 2),
                untilEnd: true,
                source: '先史遺産ヴィマナ',
              },
              { type: 'ATTACH', uid: p[0], target: env.self },
            ],
          },
        ],
      },
      logOnly('② 相手のモンスター効果の発動時、X素材を2つ取り除いて無効（相手用）', ['monster'], '先史遺産ヴィマナ②'),
    ],
  },

  // 閃刀姫－アザレア
  '98462037': {
    materialCheck: (env, m, method) =>
      method !== 'link' || (m.length === 2 && m.every((u) => ['光', '闇'].includes(env.def(u).attribute ?? '')))
        ? null
        : '光・闇属性モンスター2体が必要です',
    effects: [
      {
        label: '① 特殊召喚した場合：フィールドのカード1枚を破壊（墓地の魔法が3枚以下ならこのカードを墓地へ）',
        from: ['monster'],
        key: '閃刀姫－アザレア①',
        limit: 1,
        onSummon: true,
        trigger: true,
        targets: true,
        condition: summonedAs('special'),
        steps: [
          {
            op: 'pick',
            prompt: '破壊するフィールドのカード（対象）',
            target: true,
            from: ['field', 'oppField'],
            min: 1,
            max: 1,
            then: (env, p) => {
              const spells = env.state.gy.filter((u) => env.def(u).kind === 'spell').length;
              return [
                ...p.map((u) => toGy(u, '効果で破壊')),
                ...(spells <= 3 && onField(env, env.self) && !p.includes(env.self) ? [toGy(env.self, '効果')] : []),
              ];
            },
          },
        ],
      },
      logOnly(
        '② 相手モンスターとの戦闘のダメージステップ開始時、墓地の魔法を除外して破壊（相手用）',
        ['monster'],
        '閃刀姫－アザレア②',
      ),
    ],
  },

  // 機械仕掛けの騎士
  '41739381': {
    materialCheck: (env, m, method) =>
      method !== 'link' ||
      (m.length === 1 && isMachine(env, m[0]) && env.def(m[0]).frame !== 'link' && (env.def(m[0]).atk ?? 0) <= 1000)
        ? null
        : 'Lモンスター以外の元々の攻撃力が1000以下の機械族モンスター1体が必要です',
    effects: [
      {
        label:
          '① L召喚した場合：表側の永続魔法を墓地へ送り、デッキから「機械仕掛けの夜－クロック・ワーク・ナイト－」を手札に加える',
        from: ['monster'],
        key: '機械仕掛けの騎士①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: summonedAs('link'),
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：墓地へ送る自分フィールドの表側表示の永続魔法カード',
            from: ['spelltraps'],
            where: (env, u) => env.state.cards[u].faceUp && env.def(u).spellType === 'continuous',
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u)),
          },
          search('デッキから手札に加える「機械仕掛けの夜－クロック・ワーク・ナイト－」', {
            name: ['機械仕掛けの夜－クロック・ワーク・ナイト－'],
          }),
        ],
      },
      {
        label: '② 自分の他の機械族をリリースし、墓地の攻撃力1000以下の機械族を守備表示で特殊召喚',
        from: ['monster'],
        key: '機械仕掛けの騎士②',
        limit: 1,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: '特殊召喚する自分の墓地の攻撃力1000以下の機械族モンスター（対象）',
            target: true,
            from: ['gy'],
            where: (env, u) => env.def(u).race === MACHINE && (env.def(u).atk ?? 0) <= 1000,
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: 'リリースする自分フィールドの他の機械族モンスター → 出すゾーン',
            from: ['monsters'],
            where: (env, u) => u !== env.self && env.state.cards[u].faceUp && isMachine(env, u),
            min: 1,
            max: 1,
            zone: 'monster',
            noSummonCheck: true,
            then: (env, p, z) => [toGy(p[0], 'リリース'), ss(env.picks![0][0], z, '機械仕掛けの騎士の効果', 'def')],
          },
        ],
      },
    ],
  },

  // 終撃竜－サイバー・エンド・ドラゴン（②貫通。③の3回攻撃は記録しない）
  '30275298': {
    materialCheck: fusionCheck('30275298'),
    effects: [
      {
        label: '① 光属性だけで融合召喚した場合：4000LP払い、デッキから「リミッター解除」を手札に加える',
        from: ['monster'],
        key: '終撃竜－サイバー・エンド・ドラゴン①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: (env) => {
          const mats = env.state.cards[env.self].materials ?? [];
          return (
            summonedAs('fusion')(env) ??
            (mats.length && mats.every((u) => env.def(u).attribute === '光')
              ? null
              : '光属性モンスターだけを素材にしていません')
          );
        },
        steps: [
          { op: 'do', cost: true, then: () => [{ type: 'CHANGE_LP', delta: -4000 }] },
          search('デッキから手札に加える「リミッター解除」', { name: ['リミッター解除'] }),
        ],
      },
    ],
  },

  // 星導竜アーミライル
  '36768783': {
    materialCheck: (env, m, method) =>
      method !== 'link' ||
      (m.length === 2 &&
        m.every((u) => env.def(u).kind === 'monster' && !['normal', 'token'].includes(env.def(u).frame ?? '')))
        ? null
        : '効果モンスター2体が必要です',
    effects: [
      {
        label:
          '① リンク先のモンスターと元々のレベルが同じモンスターを、手札からリンク先に守備表示で特殊召喚（効果無効）',
        from: ['monster'],
        key: '星導竜アーミライル',
        limit: 1,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: 'このカードのリンク先の表側表示モンスター（対象）',
            target: true,
            from: ['monsters'],
            where: (env, u) => {
              const loc = env.loc(u);
              return env.state.cards[u].faceUp && loc?.zone === 'mz' && linkedTo('36768783')(env.state, env.self, loc);
            },
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: '手札から特殊召喚する、元々のレベルが同じモンスター',
            from: ['hand'],
            where: (env, u) => env.def(u).kind === 'monster' && env.def(u).level === env.def(env.picks![0][0]).level,
            min: 1,
            max: 1,
            zone: 'monster',
            zoneFilter: linkedTo('36768783'),
            then: (_, p, z) => [
              ss(p[0], z, '星導竜アーミライルの効果・効果無効', 'def'),
              { type: 'NEGATE_CARD', uid: p[0], by: '星導竜アーミライル', untilLeave: true },
            ],
          },
        ],
      },
    ],
  },

  // サイバー・エタニティ・ドラゴン（①は相手の効果への耐性）
  '82315403': {
    materialCheck: fusionCheck('82315403'),
    effects: [
      logOnly('② 融合召喚したこのカードが相手によって墓地へ送られた場合、「サイバー・ドラゴン」を特殊召喚（相手用）', [
        'gy',
      ]),
      {
        label: '③ 墓地から除外：このターン、自分の融合モンスターは相手の効果で破壊されず対象にならない',
        from: ['gy'],
        speed: 2,
        steps: [selfTo('banished')],
      },
    ],
  },

  // クリフォート・ゲニウス（①は魔法・罠と他のLモンスターの効果を受けない）
  '22423493': {
    materialCheck: (env, m, method) =>
      method !== 'link' || (m.length === 2 && m.every((u) => isMachine(env, u)))
        ? null
        : '機械族モンスター2体が必要です',
    effects: [
      {
        label: '② 自分と相手の表側表示のカードを1枚ずつ、ターン終了時まで効果を無効にする',
        from: ['monster'],
        key: 'クリフォート・ゲニウス②',
        limit: 1,
        perCard: true,
        targets: true,
        condition: (env) =>
          oppMonsters(env).length || (env.state.opp?.stz ?? []).some(Boolean)
            ? null
            : '相手フィールドに表側表示のカードがありません（相手の盤面を置くと使えます）',
        steps: [
          {
            op: 'pick',
            prompt: '効果を無効にする自分フィールドの表側表示のカード（このカード以外・対象）',
            target: true,
            from: ['field'],
            where: (env, u) => u !== env.self && env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => ({ type: 'NEGATE_CARD', uid: u, by: 'クリフォート・ゲニウス' }) as Action),
          },
          {
            op: 'pick',
            prompt: '効果を無効にする相手フィールドの表側表示のカード（対象）',
            target: true,
            from: ['oppField'],
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => ({ type: 'NEGATE_CARD', uid: u, by: 'クリフォート・ゲニウス' }) as Action),
          },
        ],
      },
      {
        label: '③ リンク先にモンスター2体が同時に特殊召喚された時：デッキからレベル5以上の機械族を手札に加える',
        from: ['monster'],
        key: 'クリフォート・ゲニウス③',
        limit: 1,
        perCard: true,
        trigger: true,
        condition: (env) => {
          const s = env.state;
          const linked = s.mz.filter(
            (u, i): u is string =>
              !!u && linkedTo('22423493')(s, env.self, { zone: 'mz', index: i }) && s.cards[u].enteredTurn === s.turn,
          );
          const groups = linked.map((u) => s.cards[u].eventGroup);
          return groups.some((g, i) => g !== undefined && groups.indexOf(g) !== i)
            ? null
            : 'リンク先にモンスター2体が同時に特殊召喚された時に発動できます';
        },
        steps: [
          search('デッキから手札に加えるレベル5以上の機械族モンスター', {
            kind: ['monster'],
            race: [MACHINE],
            minLevel: 5,
          }),
        ],
      },
    ],
  },

  // キメラテック・ランページ・ドラゴン
  '84058253': {
    materialCheck: fusionCheck('84058253'),
    effects: [
      {
        label: '① 融合召喚した時：融合素材の数までフィールドの魔法・罠を破壊',
        from: ['monster'],
        key: 'キメラテック・ランページ・ドラゴン①',
        limit: 1,
        perCard: true,
        onSummon: true,
        trigger: true,
        targets: true,
        condition: (env) => {
          const s = env.state;
          const any = [...s.stz, s.fz, ...(s.opp?.stz ?? []), s.opp?.fz ?? null].some(Boolean);
          return summonedAs('fusion')(env) ?? (any ? null : 'フィールドに魔法・罠カードがありません');
        },
        steps: [
          {
            op: 'pick',
            prompt: '破壊するフィールドの魔法・罠カード（融合素材の数まで・対象）',
            target: true,
            from: ['spelltraps', 'oppSpelltraps'],
            range: (env) => [1, Math.max(1, env.state.cards[env.self].materials?.length ?? 1)],
            then: (_, p) => p.map((u) => toGy(u, '効果で破壊')),
          },
        ],
      },
      {
        label: '② デッキから機械族・光属性モンスターを2体まで墓地へ送る（その数だけ追加で攻撃できる）',
        from: ['monster'],
        key: 'キメラテック・ランページ・ドラゴン②',
        limit: 1,
        perCard: true,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから墓地へ送る機械族・光属性モンスター（2体まで）',
            from: ['deck'],
            filter: { kind: ['monster'], race: [MACHINE], attribute: ['光'] },
            min: 1,
            max: 2,
            then: (env, p) =>
              withShuffle(
                env,
                p,
                p.map((u) => toGy(u, '効果')),
              ),
          },
        ],
      },
    ],
  },

  // サイバー・ドラゴン・ノヴァ
  '58069384': {
    materialCheck: (env, m, method) =>
      method !== 'xyz' || m.every((u) => isMachine(env, u)) ? null : '機械族モンスターを選んでください',
    effects: [
      {
        label: '① X素材を1つ取り除き、墓地の「サイバー・ドラゴン」1体を特殊召喚',
        from: ['monster'],
        key: 'サイバー・ドラゴン・ノヴァ①',
        limit: 1,
        perCard: true,
        targets: true,
        condition: (env) => (env.state.cards[env.self].overlay.length ? null : 'X素材がありません'),
        steps: [
          {
            op: 'do',
            cost: true,
            then: (env) => [{ type: 'DETACH', target: env.self, uid: env.state.cards[env.self].overlay[0] }],
          },
          ...ssTarget(
            '特殊召喚する自分の墓地の「サイバー・ドラゴン」（対象）',
            ['gy'],
            isCDName,
            'サイバー・ドラゴン・ノヴァの効果',
          ),
        ],
      },
      {
        label: '② 手札・フィールドの「サイバー・ドラゴン」を除外し、このカードの攻撃力をターン終了時まで2100アップ',
        from: ['monster'],
        key: 'サイバー・ドラゴン・ノヴァ②',
        limit: 1,
        perCard: true,
        speed: 2,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：除外する手札・フィールド（表側表示）の「サイバー・ドラゴン」',
            from: ['hand', 'monsters'],
            where: (env, u) =>
              u !== env.self &&
              (onField(env, u) ? env.state.cards[u].faceUp && isCDName(env, u) : env.def(u).name === CD),
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => move(u, { zone: 'banished' }, 'コスト')),
          },
          {
            op: 'do',
            then: (env) => [
              { type: 'STAT_MOD', uid: env.self, atk: 2100, untilEnd: true, source: 'サイバー・ドラゴン・ノヴァ' },
            ],
          },
        ],
      },
      logOnly('③ 相手の効果で墓地へ送られた場合、EXデッキから機械族の融合モンスターを特殊召喚（相手用）', ['gy']),
    ],
  },

  // キメラテック・フォートレス・ドラゴン
  '79229522': {
    procedures: [
      contactFusion(
        '「サイバー・ドラゴン」＋機械族モンスターを墓地へ送って特殊召喚（攻撃力は素材の数×1000）',
        1000,
        (env, m) =>
          m.length >= 2 && m.some((c, i) => isCDName(env, c) && m.every((o, j) => j === i || isMachine(env, o)))
            ? null
            : '「サイバー・ドラゴン」1体と機械族モンスター1体以上を選んでください',
      ),
    ],
  },
};
