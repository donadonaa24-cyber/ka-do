import { type Action, candidates, effectSummonError, type MonsterLocation, oppMonsterSlots } from '../engine/game';
import type { CardFilter } from '../engine/filters';
import { linkedZonesOf } from '../engine/rules';
import type { CardScript, EffectDef, Env, PickZone, Step } from '../engine/scripts';
import type { Attribute, CardDef, Location } from '../engine/types';
import { HERO_CARD_DATA } from './heroCards.generated';

// ＨＥＲＯデッキのカードの召喚条件・効果。相手がいる時だけ意味がある効果は、記録するだけにする。

const HERO = 'HERO';
const E_HERO = 'Ｅ・ＨＥＲＯ';
const D_HERO = 'Ｄ－ＨＥＲＯ';
const M_HERO = 'Ｍ・ＨＥＲＯ';
const HERO_MONSTER: CardFilter = { kind: ['monster'], archetype: HERO };

// ===== 部品 =====

const move = (
  uid: string,
  to: Location,
  reason?: string,
  extra: Partial<Extract<Action, { type: 'MOVE' }>> = {},
): Action => ({ type: 'MOVE', uid, to, reason, ...extra });
const toHand = (uid: string, reason = '効果') => move(uid, { zone: 'hand' }, reason);
const toGy = (uid: string, reason = 'コスト') => move(uid, { zone: 'gy' }, reason);
const ss = (
  uid: string,
  zone: Location | null,
  note: string,
  extra: Partial<Extract<Action, { type: 'SPECIAL_SUMMON' }>> = {},
): Action => ({ type: 'SPECIAL_SUMMON', uid, to: zone as MonsterLocation, note, ...extra });
const shuffle: Action = { type: 'SHUFFLE_DECK' };
const withShuffle = (env: Env, picked: string[], actions: Action[]): Action[] =>
  picked.some((u) => env.loc(u)?.zone === 'deck') ? [...actions, shuffle] : actions;
const fail = (message: string): Action => ({ type: 'FAIL', message });
const destroy = (uid: string): Action => move(uid, { zone: 'gy' }, '効果で破壊');
/** ターン終了時まで「ＨＥＲＯ」モンスターしか特殊召喚できない（all でなければEXデッキからだけ） */
const heroLock = (source: string, all: boolean): Action => ({
  type: 'EXTRA_LOCK',
  source,
  filter: { archetype: HERO },
  all,
});
const lockStep = (source: string, all: boolean): Step => ({
  op: 'do',
  cost: true,
  then: () => [heroLock(source, all)],
});
/** LPを半分払う */
const payHalfLp = (source: string): Step => ({
  op: 'do',
  cost: true,
  then: (env) => [{ type: 'LP_SET', lp: Math.ceil(env.state.lp / 2), reason: `${source}のコスト（LPを半分払う）` }],
});

const has = (env: Env, u: string, archetype: string) => !!env.def(u).archetypes?.includes(archetype);
const isHero = (env: Env, u: string) => env.def(u).kind === 'monster' && has(env, u, HERO);
const onField = (env: Env, u: string) => ['mz', 'emz'].includes(env.loc(u)?.zone ?? '');
const ownMonsters = (env: Env) => [...env.state.mz, ...env.state.emz].filter((u): u is string => !!u);
const ownFaceUpMonsters = (env: Env) => ownMonsters(env).filter((u) => env.state.cards[u].faceUp);
const oppMonsters = (env: Env) => (env.state.opp ? oppMonsterSlots(env.state.opp) : []).filter((u): u is string => !!u);
const levelOf = (env: Env, u: string) => env.def(u).level ?? 0;
/** 属性（Ｃ・ＨＥＲＯ カオスはモンスターゾーンでは光属性としても扱う） */
const attributesOf = (env: Env, u: string): Attribute[] => {
  const a = env.def(u).attribute;
  const list: Attribute[] = a ? [a] : [];
  if (env.def(u).id === '23204029' && onField(env, u)) list.push('光');
  return list;
};

const mainPhase = (env: Env) =>
  !env.state.opponentTurn && (env.state.phase === 'M1' || env.state.phase === 'M2')
    ? null
    : '自分のメインフェイズにのみ発動できます';
const oppTurn = (env: Env) =>
  env.state.opponentTurn ? null : '相手ターンにのみ発動できます（メニューの「相手ターンへ」で相手ターンに進めます）';

const selfTo = (zone: 'gy' | 'banished', reason = 'コスト'): Step => ({
  op: 'do',
  cost: reason === 'コスト',
  then: (env) => [move(env.self, { zone }, reason)],
});
const ssSelf = (note: string, extra: Partial<Extract<Action, { type: 'SPECIAL_SUMMON' }>> = {}): Step => ({
  op: 'place',
  prompt: 'このカードを出すゾーンを選択',
  zone: 'monster',
  then: (env, zone) => [ss(env.self, zone, note, extra)],
});
const search = (
  prompt: string,
  filter: CardFilter,
  where?: (env: Env, uid: string) => boolean,
  from: PickZone[] = ['deck'],
): Step => ({
  op: 'pick',
  prompt,
  from,
  filter,
  where,
  min: 1,
  max: 1,
  then: (env, p) =>
    withShuffle(
      env,
      p,
      p.map((u) => toHand(u, env.loc(u)?.zone === 'deck' ? 'サーチ' : '効果')),
    ),
});
/** 墓地の「ＨＥＲＯ」モンスター1体を除外する（コスト） */
const banishHeroCost = (prompt = 'コスト：除外する自分の墓地の「ＨＥＲＯ」モンスター'): Step => ({
  op: 'pick',
  cost: true,
  prompt,
  from: ['gy'],
  filter: HERO_MONSTER,
  min: 1,
  max: 1,
  then: (_, p) => p.map((u) => move(u, { zone: 'banished' }, 'コスト')),
});
/** 対象のモンスターを特殊召喚する（対象は発動時、出すゾーンは解決時に選ぶ） */
const ssTarget = (
  prompt: string,
  from: PickZone[],
  where: (env: Env, uid: string) => boolean,
  note: string,
): Step[] => [
  { op: 'pick', prompt, target: true, from, where, min: 1, max: 1, then: () => [] },
  {
    op: 'place',
    prompt: '対象のモンスターを出すゾーンを選択',
    zone: 'monster',
    then: (env, z) => [ss(env.picks![0][0], z, note)],
  },
];

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

const summonedAs = (how: 'normal' | 'special' | 'fusion' | 'link') => (env: Env) => {
  const t = env.state.cards[env.self].summonType;
  const ok = how === 'special' ? !!t && t !== 'normal' : t === how;
  return ok
    ? null
    : `${{ normal: '召喚', special: '特殊召喚', fusion: '融合召喚', link: 'L召喚' }[how]}した時に発動できます`;
};
/** このターンにこのカードが墓地へ送られた */
const sentToGyThisTurn = (env: Env) => {
  const inst = env.state.cards[env.self];
  return inst.movedTurn === env.state.turn && env.loc(env.self)?.zone === 'gy'
    ? null
    : 'このターンに墓地へ送られていません';
};
/** このターンにフィールドで破壊された */
const destroyedThisTurn = (env: Env) => {
  const inst = env.state.cards[env.self];
  return inst.movedTurn === env.state.turn &&
    ['mz', 'emz'].includes(inst.movedFrom ?? '') &&
    (inst.movedReason ?? '').includes('破壊')
    ? null
    : 'このターンにフィールドで破壊されていません';
};
const linkMaterials =
  (message: string, ok: (env: Env, u: string) => boolean): CardScript['materialCheck'] =>
  (env, m, method) =>
    method !== 'link' || (m.length === 2 && m.every((u) => ok(env, u))) ? null : message;

// ===== 融合 =====

/** 融合モンスターの素材の条件 */
interface FusionRecipe {
  range: [number, number];
  candidate: (env: Env, u: string) => boolean;
  check: (env: Env, m: string[]) => string | null;
}
const differentAttributes = (env: Env, m: string[]) => new Set(m.map((u) => env.def(u).attribute)).size === m.length;

const FUSION: Record<string, FusionRecipe> = {
  // Ｄ－ＨＥＲＯ デストロイフェニックスガイ：レベル６以上の「ＨＥＲＯ」モンスター＋「Ｄ－ＨＥＲＯ」モンスター
  '60461804': {
    range: [2, 2],
    candidate: isHero,
    check: (env, m) =>
      m.length === 2 && m.some((u, i) => isHero(env, u) && levelOf(env, u) >= 6 && has(env, m[1 - i], D_HERO))
        ? null
        : 'レベル6以上の「ＨＥＲＯ」モンスター＋「Ｄ－ＨＥＲＯ」モンスターが必要です',
  },
  // Ｅ・ＨＥＲＯ シャイニング・ネオス・ウィングマン：「Ｅ・ＨＥＲＯ ネオス」＋「ウィングマン」融合モンスター
  '56733747': {
    range: [2, 2],
    candidate: (env, u) =>
      env.def(u).name === 'Ｅ・ＨＥＲＯ ネオス' || (env.def(u).frame === 'fusion' && has(env, u, 'ウィングマン')),
    check: (env, m) =>
      m.length === 2 &&
      m.some(
        (u, i) =>
          env.def(u).name === 'Ｅ・ＨＥＲＯ ネオス' &&
          env.def(m[1 - i]).frame === 'fusion' &&
          has(env, m[1 - i], 'ウィングマン'),
      )
        ? null
        : '「Ｅ・ＨＥＲＯ ネオス」＋「ウィングマン」融合モンスターが必要です',
  },
  // Ｃ・ＨＥＲＯ カオス：「Ｍ・ＨＥＲＯ」モンスター×２
  '23204029': {
    range: [2, 2],
    candidate: (env, u) => has(env, u, M_HERO),
    check: (env, m) =>
      m.length === 2 && m.every((u) => has(env, u, M_HERO)) ? null : '「Ｍ・ＨＥＲＯ」モンスター2体が必要です',
  },
  // Ｅ・ＨＥＲＯ サンライザー：属性が異なる「ＨＥＲＯ」モンスター×２
  '22908820': {
    range: [2, 2],
    candidate: isHero,
    check: (env, m) =>
      m.length === 2 && m.every((u) => isHero(env, u)) && differentAttributes(env, m)
        ? null
        : '属性が異なる「ＨＥＲＯ」モンスター2体が必要です',
  },
  // Ｅ・ＨＥＲＯ フレイム・ウィングマン－フレイム・シュート：属性が異なる「Ｅ・ＨＥＲＯ」モンスター×２
  '93347961': {
    range: [2, 2],
    candidate: (env, u) => has(env, u, E_HERO),
    check: (env, m) =>
      m.length === 2 && m.every((u) => has(env, u, E_HERO)) && differentAttributes(env, m)
        ? null
        : '属性が異なる「Ｅ・ＨＥＲＯ」モンスター2体が必要です',
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
  /** 素材の行き先（ミラクル・フュージョンは除外） */
  materialsTo?: 'banished';
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
/** 素材にできるカード（同名カードは2枚まで調べる） */
const materialPool = (env: Env, zones: string[], recipe: FusionRecipe) => {
  const seen: Record<string, number> = {};
  return candidates(env.state, zones).filter((u) => {
    if (env.def(u).kind !== 'monster' || !recipe.candidate(env, u)) return false;
    const n = env.def(u).name;
    seen[n] = (seen[n] ?? 0) + 1;
    return seen[n] <= 2;
  });
};

const fusionTargetPossible = (env: Env, opts: FusionOpts, t: string): boolean => {
  const recipe = FUSION[env.def(t).id];
  if (!recipe || env.def(t).frame !== 'fusion' || !opts.monster(env, t)) return false;
  if (effectSummonError(env.state, env.ctx, t, 'fusion')) return false;
  const mats = materialPool(env, opts.from, recipe);
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
const fusionSteps = (opts: FusionOpts): Step[] => [
  {
    op: 'pick',
    prompt: 'EXデッキから融合召喚する融合モンスター',
    from: ['extra'],
    filter: { kind: ['monster'], frame: ['fusion'] },
    where: (env, u) => fusionTargetPossible(env, opts, u),
    min: 1,
    max: 1,
    then: () => [],
  },
  {
    op: 'pick',
    prompt: `融合素材（${opts.materialsTo === 'banished' ? '除外する' : '墓地へ送る'}）→ 出すゾーンを選択`,
    from: opts.from,
    where: (env, u) => {
      const target = env.picks?.[0]?.[0];
      return !!target && env.def(u).kind === 'monster' && FUSION[env.def(target).id].candidate(env, u);
    },
    range: (env) => {
      const target = env.picks?.[0]?.[0];
      return target ? FUSION[env.def(target).id].range : [1, 1];
    },
    zone: 'monster',
    noSummonCheck: true,
    then: (env, p, z) => {
      const target = env.picks![0][0];
      const err = FUSION[env.def(target).id].check(env, p) ?? opts.materials?.(env, p);
      if (err) return [fail(err)];
      return [
        {
          type: 'PROCEDURE_SUMMON',
          method: 'fusion',
          uid: target,
          materials: p,
          to: z as MonsterLocation,
          materialZones: opts.from.map((f) => (f === 'monsters' ? 'field' : f)),
          materialsTo: opts.materialsTo,
          by: opts.by,
        },
        ...(p.some((u) => env.loc(u)?.zone === 'deck') ? [shuffle] : []),
        ...(opts.after?.(env, target, p) ?? []),
      ];
    },
  },
];

const POLYMERIZATION: FusionOpts = { by: '融合', from: ['hand', 'monsters'], monster: () => true };
const FUSION_DESTINY: FusionOpts = {
  by: 'フュージョン・デステニー',
  from: ['hand', 'deck'],
  // 「Ｄ－ＨＥＲＯ」モンスターを融合素材とする融合モンスター
  monster: (env, u) => (env.def(u).materialText ?? '').includes(D_HERO),
  materials: (env, m) =>
    m.some((u) => has(env, u, D_HERO)) ? null : '「Ｄ－ＨＥＲＯ」モンスターを素材に含めてください',
  after: (_, target) => [{ type: 'DESTROY_AT_END', uid: target, nextTurn: true }],
};
const MIRACLE_FUSION: FusionOpts = {
  by: 'ミラクル・フュージョン',
  from: ['monsters', 'gy'],
  monster: (env, u) => has(env, u, E_HERO),
  materialsTo: 'banished',
};

/** ＥＸデッキの融合モンスターにカード名が記された融合素材（「Ｅ・ＨＥＲＯ ネオス」など） */
const namedMaterials = (def: CardDef): string[] =>
  [...(def.materialText ?? '').matchAll(/「([^」]+)」/g)].map((m) => m[1]);
/** デッキに、その融合モンスターにカード名が記された融合素材がある（ヘル・デバイサー①） */
const hasNamedInDeck = (env: Env, u: string) => {
  const names = namedMaterials(env.def(u));
  return env.state.deck.some((d) => names.includes(env.def(d).name));
};
/** そのカードの属性が出せる「Ｍ・ＨＥＲＯ」がEXデッキにいる（マスク・チェンジ） */
const maskChangeTargets = (env: Env, attrs: Attribute[]) =>
  env.state.extra.filter(
    (u) => has(env, u, M_HERO) && attrs.includes(env.def(u).attribute as Attribute) && env.def(u).frame === 'fusion',
  );
/** 「融合」魔法カード・「フュージョン」魔法カード・「チェンジ」速攻魔法カード（ワンダー・ドライバー①） */
const isFusionOrChangeSpell = (env: Env, u: string) => {
  const d = env.def(u);
  return (
    d.kind === 'spell' &&
    (has(env, u, '融合') || has(env, u, 'フュージョン') || (has(env, u, 'チェンジ') && d.spellType === 'quick'))
  );
};
/** そのリンクモンスターのリンク先（自分のメインモンスターゾーン） */
const linkedMonsters = (env: Env, self: string): string[] => {
  const def = HERO_CARD_DATA.find((c) => c.id === env.def(self).id)!;
  return linkedZonesOf(env.state, self, def)
    .map((i) => env.state.mz[i])
    .filter((u): u is string => !!u);
};

/** フェイバリット・コンタクトで素材を戻せる場所 */
const FAVORITE_FROM: PickZone[] = ['hand', 'monsters', 'gy', 'banished'];
/** フェイバリット・コンタクトで出せる融合モンスター（「ＨＥＲＯ」を素材とし、素材が揃っている） */
function favoriteTargetPossible(env: Env, t: string): boolean {
  const recipe = FUSION[env.def(t).id];
  if (!recipe || env.def(t).frame !== 'fusion' || !(env.def(t).materialText ?? '').includes('ＨＥＲＯ')) return false;
  if (effectSummonError(env.state, env.ctx, t, 'fusion')) return false;
  const mats = materialPool(env, FAVORITE_FROM, recipe).filter((u) => u !== t);
  for (let k = recipe.range[0]; k <= Math.min(recipe.range[1], mats.length); k++)
    if (someCombo(mats, k, (c) => !recipe.check(env, c))) return true;
  return false;
}

// ===== カードの見た目以外の性質 =====

export const HERO_OVERRIDES: Record<string, Partial<CardDef>> = {
  // このカード名のカードは1ターンに1枚しか発動できない
  '52947044': { oncePerTurnActivation: true },
  '75047173': { oncePerTurnActivation: true },
  // 融合召喚でしか特殊召喚できない
  '56733747': { onlyBy: 'fusion' },
  '23204029': { onlyBy: 'fusion' },
  '22908820': { onlyBy: 'fusion' },
  '93347961': { onlyBy: 'fusion' },
  // Ｍ・ＨＥＲＯ ダーク・ロウ：「マスク・チェンジ」の効果でのみ特殊召喚できる
  '58481572': {
    onlyByEffectOf: 'マスク・チェンジ',
    materialText: '「マスク・チェンジ」の効果でのみ特殊召喚できる',
  },
};

// ===== カードごとの召喚条件・効果 =====

export const HERO_SCRIPTS: Record<string, CardScript> = {
  // ハネクリボー・サバティエル ＬＶ１０
  '40237839': {
    effects: [
      {
        label: '① 手札から見せ、LPを半分払う：「融合」「フュージョン」魔法カードを手札に加え、このカードをデッキに戻す',
        from: ['hand'],
        key: 'ハネクリボー・サバティエル ＬＶ１０①',
        limit: 1,
        condition: mainPhase,
        steps: [
          payHalfLp('ハネクリボー・サバティエル ＬＶ１０'),
          {
            op: 'pick',
            prompt: 'デッキから手札に加える「融合」魔法カードか「フュージョン」魔法カード',
            from: ['deck'],
            filter: { kind: ['spell'], any: [{ archetype: '融合' }, { archetype: 'フュージョン' }] },
            min: 1,
            max: 1,
            then: (env, p) => [
              ...p.map((u) => toHand(u, 'サーチ')),
              move(env.self, { zone: 'deck' }, 'ハネクリボー・サバティエル ＬＶ１０の効果'),
              shuffle,
              heroLock('ハネクリボー・サバティエル ＬＶ１０', false),
            ],
          },
        ],
      },
      {
        label: '② 相手ターン・LPが1000以下：手札から特殊召喚（相手へのダメージは記録のみ）',
        from: ['hand'],
        key: 'ハネクリボー・サバティエル ＬＶ１０②',
        limit: 1,
        speed: 2,
        condition: (env) => oppTurn(env) ?? (env.state.lp <= 1000 ? null : 'LPが1000以下の時に発動できます'),
        steps: [ssSelf('自身の効果')],
      },
    ],
  },

  // フュージョン・デステニー
  '52947044': {
    effects: [
      {
        label:
          '発動：手札・デッキの素材で「Ｄ－ＨＥＲＯ」を素材とする融合モンスターを融合召喚（次のターンのエンドフェイズに破壊・このターン闇属性の「ＨＥＲＯ」しか特殊召喚できない）',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: fusionPossible(FUSION_DESTINY),
        steps: [
          {
            op: 'do',
            cost: true,
            then: () => [
              {
                type: 'EXTRA_LOCK',
                source: 'フュージョン・デステニー',
                filter: { archetype: HERO, attribute: ['闇'] },
                all: true,
              },
            ],
          },
          ...fusionSteps(FUSION_DESTINY),
        ],
      },
    ],
  },

  // Ｄ－ＨＥＲＯ ディアボリックガイ
  '9411399': {
    effects: [
      {
        label: '① 墓地から除外：デッキから「Ｄ－ＨＥＲＯ ディアボリックガイ」を特殊召喚',
        from: ['gy'],
        // ターン制限は無い（1枚ごとに1回だけ使える）
        key: 'Ｄ－ＨＥＲＯ ディアボリックガイ①',
        perCard: true,
        condition: mainPhase,
        steps: [
          selfTo('banished'),
          {
            op: 'pick',
            prompt: 'デッキから特殊召喚する「Ｄ－ＨＥＲＯ ディアボリックガイ」',
            from: ['deck'],
            filter: { name: ['Ｄ－ＨＥＲＯ ディアボリックガイ'] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'Ｄ－ＨＥＲＯ ディアボリックガイの効果'), shuffle],
          },
        ],
      },
    ],
  },

  // Ｍ・ＨＥＲＯ ファウンティン
  '66206748': {
    effects: [
      {
        label: '① 手札から見せる：手札の「ＨＥＲＯ」モンスターを守備表示で特殊召喚',
        from: ['hand'],
        key: 'Ｍ・ＨＥＲＯ ファウンティン①',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            prompt: '手札から守備表示で特殊召喚する「ＨＥＲＯ」モンスター',
            from: ['hand'],
            filter: HERO_MONSTER,
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'Ｍ・ＨＥＲＯ ファウンティンの効果', { position: 'def' })],
          },
        ],
      },
      {
        label: '② 効果で・効果のコストで墓地へ送られた：デッキ・墓地の「マスク・チェンジ」をセット',
        from: ['gy'],
        key: 'Ｍ・ＨＥＲＯ ファウンティン②',
        limit: 1,
        trigger: true,
        condition: (env) => {
          const why = env.state.cards[env.self].movedReason ?? '';
          return (
            sentToGyThisTurn(env) ??
            (why && why !== '素材' && why !== '戦闘で破壊' ? null : 'カードの効果で墓地へ送られていません')
          );
        },
        steps: [
          {
            op: 'pick',
            prompt: 'セットする「マスク・チェンジ」（デッキ・墓地）→ 置くゾーン',
            from: ['deck', 'gy'],
            filter: { name: ['マスク・チェンジ'] },
            min: 1,
            max: 1,
            zone: 'stz',
            then: (env, p, z) =>
              withShuffle(env, p, [move(p[0], z!, 'Ｍ・ＨＥＲＯ ファウンティンの効果でセット', { faceUp: false })]),
          },
        ],
      },
    ],
  },

  // Ｄ－ＨＥＲＯ デストロイフェニックスガイ（①の攻撃力ダウンは相手のモンスターだけなので省略）
  '60461804': {
    materialCheck: fusionCheck('60461804'),
    effects: [
      {
        label: '② 自分フィールドのカード1枚とフィールドのカード1枚を破壊',
        from: ['monster'],
        key: 'Ｄ－ＨＥＲＯ デストロイフェニックスガイ②',
        limit: 1,
        speed: 2,
        condition: (env) =>
          candidates(env.state, ['field', 'oppField']).length >= 2 ? null : 'フィールドにカードが2枚以上必要です',
        steps: [
          {
            op: 'pick',
            prompt: '破壊する自分フィールドのカード',
            from: ['monsters', 'spelltraps'],
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: '破壊するフィールドのカード（もう1枚）',
            from: ['field', 'oppField'],
            where: (env, u) => u !== env.picks?.[0]?.[0],
            min: 1,
            max: 1,
            then: (env, p) => [...env.picks![0], ...p].map(destroy),
          },
        ],
      },
      {
        label: '③ 戦闘・効果で破壊された：次のターンのスタンバイフェイズに墓地の「Ｄ－ＨＥＲＯ」を特殊召喚する',
        from: ['gy', 'banished'],
        key: 'Ｄ－ＨＥＲＯ デストロイフェニックスガイ③',
        limit: 1,
        trigger: true,
        condition: destroyedThisTurn,
        steps: [
          {
            op: 'do',
            then: (env) => [
              {
                type: 'ACTIVATE_EFFECT',
                uid: env.self,
                silent: true,
                key: `duel:デストロイフェニックスガイ③:${env.state.turn + 1}`,
              },
            ],
          },
        ],
      },
      {
        label: '③の続き（次のターンのスタンバイフェイズ）：墓地の「Ｄ－ＨＥＲＯ」1体を特殊召喚',
        from: ['gy', 'banished', 'monster'],
        key: 'Ｄ－ＨＥＲＯ デストロイフェニックスガイ③（特殊召喚）',
        limit: 1,
        applied: true,
        trigger: true,
        condition: (env) =>
          !env.state.effectUses[`duel:デストロイフェニックスガイ③:${env.state.turn}`]
            ? '③の効果を発動した次のターンではありません'
            : env.state.phase === 'SP' || env.state.opponentTurn
              ? null
              : 'スタンバイフェイズに特殊召喚します',
        steps: [
          {
            op: 'pick',
            prompt: '墓地から特殊召喚する「Ｄ－ＨＥＲＯ」モンスター',
            from: ['gy'],
            filter: { kind: ['monster'], archetype: D_HERO },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'Ｄ－ＨＥＲＯ デストロイフェニックスガイの効果')],
          },
        ],
      },
    ],
  },

  // Ｘ・ＨＥＲＯ クロスガイ
  '58004362': {
    materialCheck: linkMaterials('素材は戦士族モンスター2体です', (env, u) => env.def(u).race === '戦士族'),
    effects: [
      {
        label: '① L召喚した場合：墓地の「Ｄ－ＨＥＲＯ」を特殊召喚（このターン「ＨＥＲＯ」しか特殊召喚できない）',
        from: ['monster'],
        key: 'Ｘ・ＨＥＲＯ クロスガイ①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: (env) =>
          summonedAs('link')(env) ??
          (env.state.gy.some((u) => has(env, u, D_HERO) && env.def(u).kind === 'monster')
            ? null
            : '墓地に「Ｄ－ＨＥＲＯ」モンスターがいません'),
        steps: [
          lockStep('Ｘ・ＨＥＲＯ クロスガイ', true),
          ...ssTarget(
            '特殊召喚する墓地の「Ｄ－ＨＥＲＯ」モンスター（対象）',
            ['gy'],
            (env, u) => env.def(u).kind === 'monster' && has(env, u, D_HERO),
            'Ｘ・ＨＥＲＯ クロスガイの効果',
          ),
        ],
      },
      {
        label: '② 「Ｄ－ＨＥＲＯ」をリリース：カード名が異なる「ＨＥＲＯ」モンスターをデッキから手札に加える',
        from: ['monster'],
        key: 'Ｘ・ＨＥＲＯ クロスガイ②',
        limit: 1,
        condition: mainPhase,
        steps: [
          lockStep('Ｘ・ＨＥＲＯ クロスガイ', true),
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：リリースする自分フィールドの「Ｄ－ＨＥＲＯ」モンスター',
            from: ['monsters'],
            where: (env, u) => has(env, u, D_HERO) && env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, 'リリース')),
          },
          search(
            'デッキから手札に加える、リリースしたモンスターとカード名が異なる「ＨＥＲＯ」モンスター',
            HERO_MONSTER,
            (env, u) => !(env.picks ?? []).flat().some((r) => env.def(r).name === env.def(u).name),
          ),
        ],
      },
    ],
  },

  // Ｖ・ＨＥＲＯ ヴァイオン
  '27780618': {
    effects: [
      {
        label: '① 召喚・特殊召喚した場合：デッキから「ＨＥＲＯ」モンスターを墓地へ送る',
        from: ['monster'],
        key: 'Ｖ・ＨＥＲＯ ヴァイオン①',
        limit: 1,
        onSummon: true,
        trigger: true,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから墓地へ送る「ＨＥＲＯ」モンスター',
            from: ['deck'],
            filter: HERO_MONSTER,
            min: 1,
            max: 1,
            then: (_, p) => [...p.map((u) => toGy(u, '効果')), shuffle],
          },
        ],
      },
      {
        label: '② 墓地の「ＨＥＲＯ」を除外：デッキから「融合」を手札に加える',
        from: ['monster'],
        key: 'Ｖ・ＨＥＲＯ ヴァイオン②',
        limit: 1,
        perCard: true,
        condition: mainPhase,
        steps: [banishHeroCost(), search('デッキから手札に加える「融合」', { name: ['融合'] })],
      },
    ],
  },

  // Ｅ・ＨＥＲＯ シャドー・ミスト（①②はどちらか1つを1ターンに1度）
  '50720316': {
    effects: [
      {
        label: '① 特殊召喚した場合：デッキから「チェンジ」速攻魔法カードを手札に加える',
        from: ['monster'],
        key: 'Ｅ・ＨＥＲＯ シャドー・ミスト①②',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: summonedAs('special'),
        steps: [
          search('デッキから手札に加える「チェンジ」速攻魔法カード', {
            kind: ['spell'],
            spellType: ['quick'],
            archetype: 'チェンジ',
          }),
        ],
      },
      {
        label:
          '② 墓地へ送られた場合：デッキから「Ｅ・ＨＥＲＯ シャドー・ミスト」以外の「ＨＥＲＯ」モンスターを手札に加える',
        from: ['gy'],
        key: 'Ｅ・ＨＥＲＯ シャドー・ミスト①②',
        limit: 1,
        trigger: true,
        condition: sentToGyThisTurn,
        steps: [
          search('デッキから手札に加える「ＨＥＲＯ」モンスター', {
            ...HERO_MONSTER,
            excludeName: ['Ｅ・ＨＥＲＯ シャドー・ミスト'],
          }),
        ],
      },
    ],
  },

  // Ｍ・ＨＥＲＯ ダスク・クロウ
  '10808715': {
    effects: [
      {
        label: '① 手札：墓地の「ＨＥＲＯ」を除外して、このカードを特殊召喚',
        from: ['hand'],
        key: 'Ｍ・ＨＥＲＯ ダスク・クロウ①',
        limit: 1,
        condition: mainPhase,
        steps: [banishHeroCost(), ssSelf('自身の効果')],
      },
      {
        label:
          '② 召喚・特殊召喚した場合：デッキ・墓地から「Ｍ・ＨＥＲＯ ダスク・クロウ」以外の「Ｍ・ＨＥＲＯ」を手札に加える',
        from: ['monster'],
        key: 'Ｍ・ＨＥＲＯ ダスク・クロウ②',
        limit: 1,
        onSummon: true,
        trigger: true,
        steps: [
          search(
            'デッキ・墓地から手札に加える「Ｍ・ＨＥＲＯ」モンスター',
            { kind: ['monster'], archetype: M_HERO, excludeName: ['Ｍ・ＨＥＲＯ ダスク・クロウ'] },
            undefined,
            ['deck', 'gy'],
          ),
        ],
      },
    ],
  },

  // 融合
  '24094653': {
    effects: [
      {
        label: '発動：手札・フィールドのモンスターを素材に融合召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: fusionPossible(POLYMERIZATION),
        steps: fusionSteps(POLYMERIZATION),
      },
    ],
  },

  // Ｘ・ＨＥＲＯ ヘル・デバイサー（②はリンク先の悪魔族の強化なので省略）
  '19324993': {
    materialCheck: linkMaterials('素材は「ＨＥＲＯ」モンスター2体です', isHero),
    effects: [
      {
        label:
          '① L召喚した場合：EXデッキの「ＨＥＲＯ」融合モンスターを見せ、カード名が記された融合素材を2体までデッキから手札に加える',
        from: ['monster'],
        key: 'Ｘ・ＨＥＲＯ ヘル・デバイサー①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: (env) =>
          summonedAs('link')(env) ??
          (env.state.extra.some((u) => isHero(env, u) && env.def(u).frame === 'fusion' && hasNamedInDeck(env, u))
            ? null
            : 'デッキに、EXデッキの「ＨＥＲＯ」融合モンスターにカード名が記された融合素材がありません'),
        steps: [
          lockStep('Ｘ・ＨＥＲＯ ヘル・デバイサー', true),
          {
            op: 'pick',
            prompt: '相手に見せるEXデッキの「ＨＥＲＯ」融合モンスター',
            from: ['extra'],
            filter: { kind: ['monster'], frame: ['fusion'], archetype: HERO },
            where: hasNamedInDeck,
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: 'デッキから手札に加える融合素材モンスター（2体まで・同名カードは1枚まで）',
            from: ['deck'],
            where: (env, u) => {
              const shown = env.picks?.[0]?.[0];
              return (
                !!shown && env.def(u).kind === 'monster' && namedMaterials(env.def(shown)).includes(env.def(u).name)
              );
            },
            min: 1,
            max: 2,
            then: (env, p) =>
              new Set(p.map((u) => env.def(u).name)).size < p.length
                ? [fail('同名カードは1枚までです')]
                : [...p.map((u) => toHand(u, 'サーチ')), shuffle],
          },
        ],
      },
    ],
  },

  // Ｅ・ＨＥＲＯ シャイニング・ネオス・ウィングマン（②の攻撃力アップ・③の戦闘ダメージは省略）
  '56733747': {
    materialCheck: fusionCheck('56733747'),
    effects: [
      {
        label: '① 特殊召喚した場合：フィールドのモンスターの属性の種類の数まで、相手フィールドのカードを破壊',
        from: ['monster'],
        key: 'Ｅ・ＨＥＲＯ シャイニング・ネオス・ウィングマン①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: (env) => {
          const opp = env.state.opp;
          const any = !!opp && [...oppMonsterSlots(opp), ...(opp.stz ?? []), opp.fz ?? null].some(Boolean);
          return (
            summonedAs('special')(env) ??
            (any ? null : '相手フィールドにカードがありません（相手の盤面を置くと使えます）')
          );
        },
        steps: [
          {
            op: 'pick',
            prompt: '破壊する相手フィールドのカード（フィールドのモンスターの属性の種類の数まで）',
            from: ['oppField'],
            range: (env) => {
              const attrs = new Set(
                [...ownFaceUpMonsters(env), ...oppMonsters(env)].flatMap((u) => attributesOf(env, u)),
              );
              return [1, Math.max(1, attrs.size)];
            },
            then: (_, p) => p.map(destroy),
          },
        ],
      },
    ],
  },

  // Ｃ・ＨＥＲＯ カオス（①モンスターゾーンでは光属性としても扱う）
  '23204029': {
    materialCheck: fusionCheck('23204029'),
    effects: [
      {
        label: '② フィールドの表側表示カード1枚の効果をターン終了時まで無効',
        from: ['monster'],
        key: 'Ｃ・ＨＥＲＯ カオス②',
        limit: 1,
        perCard: true,
        speed: 2,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: '効果を無効にするフィールドの表側表示のカード（対象）',
            target: true,
            from: ['field', 'oppField'],
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => ({ type: 'NEGATE_CARD', uid: u, by: 'Ｃ・ＨＥＲＯ カオス' }) as Action),
          },
        ],
      },
    ],
  },

  // マスク・チェンジ
  '21143940': {
    effects: [
      {
        label: '発動：自分の「ＨＥＲＯ」を墓地へ送り、同じ属性の「Ｍ・ＨＥＲＯ」をEXデッキから特殊召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        targets: true,
        condition: (env) =>
          ownFaceUpMonsters(env).some((u) => isHero(env, u) && maskChangeTargets(env, attributesOf(env, u)).length)
            ? null
            : '同じ属性の「Ｍ・ＨＥＲＯ」がEXデッキにいる「ＨＥＲＯ」モンスターが自分フィールドにいません',
        steps: [
          {
            op: 'pick',
            prompt: '墓地へ送る自分フィールドの「ＨＥＲＯ」モンスター（対象）',
            target: true,
            from: ['monsters'],
            where: (env, u) =>
              env.state.cards[u].faceUp && isHero(env, u) && maskChangeTargets(env, attributesOf(env, u)).length > 0,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '効果')),
          },
          {
            op: 'pick',
            prompt: 'EXデッキから特殊召喚する、同じ属性の「Ｍ・ＨＥＲＯ」',
            from: ['extra'],
            where: (env, u) => {
              const sent = env.picks?.[0]?.[0];
              return !!sent && maskChangeTargets(env, attributesOf(env, sent)).includes(u);
            },
            min: 1,
            max: 1,
            zone: 'monster',
            noSummonCheck: true,
            then: (env, p, z) =>
              env.loc(env.picks![0][0])?.zone === 'gy'
                ? [ss(p[0], z, 'マスク・チェンジの効果', { ignoreConditions: true, proper: true })]
                : [],
          },
        ],
      },
    ],
  },

  // Ｍ・ＨＥＲＯ ダーク・ロウ
  '58481572': {
    materialCheck: (_env, _m, method) =>
      method === 'fusion' ? '「マスク・チェンジ」の効果でのみ特殊召喚できます' : null,
    effects: [
      logOnly('① 相手の墓地へ送られるカードは除外される（相手用）', ['monster']),
      logOnly(
        '② 相手がドローフェイズ以外でデッキから手札に加えた場合、相手の手札をランダムに1枚除外（相手用）',
        ['monster'],
        'Ｍ・ＨＥＲＯ ダーク・ロウ②',
      ),
    ],
  },

  // ヒーローアライブ
  '8949584': {
    effects: [
      {
        label: '発動：LPを半分払い、デッキからレベル4以下の「Ｅ・ＨＥＲＯ」を特殊召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: (env) => (ownFaceUpMonsters(env).length ? '自分フィールドに表側表示モンスターがいます' : null),
        steps: [
          payHalfLp('ヒーローアライブ'),
          {
            op: 'pick',
            prompt: 'デッキから特殊召喚するレベル4以下の「Ｅ・ＨＥＲＯ」モンスター',
            from: ['deck'],
            filter: { kind: ['monster'], archetype: E_HERO, maxLevel: 4 },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'ヒーローアライブの効果'), shuffle],
          },
        ],
      },
    ],
  },

  // Ｅ・ＨＥＲＯ エアーマン（①はどちらか1つ）
  '40044918': {
    effects: [
      {
        label: '①● 召喚・特殊召喚した時：デッキから「ＨＥＲＯ」モンスターを手札に加える',
        from: ['monster'],
        key: 'Ｅ・ＨＥＲＯ エアーマン①',
        limit: 1,
        perCard: true,
        onSummon: true,
        trigger: true,
        steps: [search('デッキから手札に加える「ＨＥＲＯ」モンスター', HERO_MONSTER)],
      },
      {
        label: '①● 召喚・特殊召喚した時：他の自分の「ＨＥＲＯ」の数まで、フィールドの魔法・罠カードを破壊',
        from: ['monster'],
        key: 'Ｅ・ＨＥＲＯ エアーマン①',
        limit: 1,
        perCard: true,
        onSummon: true,
        trigger: true,
        condition: (env) => {
          const heroes = ownFaceUpMonsters(env).filter((u) => u !== env.self && isHero(env, u)).length;
          const st = [...env.state.stz, env.state.fz, ...(env.state.opp?.stz ?? []), env.state.opp?.fz ?? null];
          return !heroes
            ? '他の自分の「ＨＥＲＯ」モンスターがいません'
            : st.some(Boolean)
              ? null
              : 'フィールドに魔法・罠カードがありません';
        },
        steps: [
          {
            op: 'pick',
            prompt: '破壊するフィールドの魔法・罠カード',
            from: ['spelltraps', 'oppSpelltraps'],
            range: (env) => [1, ownFaceUpMonsters(env).filter((u) => u !== env.self && isHero(env, u)).length],
            then: (_, p) => p.map(destroy),
          },
        ],
      },
    ],
  },

  // Ｅ・ＨＥＲＯ サンライザー（②の攻撃力アップは省略）
  '22908820': {
    materialCheck: fusionCheck('22908820'),
    effects: [
      {
        label: '① 特殊召喚した場合：デッキから「ミラクル・フュージョン」を手札に加える',
        from: ['monster'],
        key: 'Ｅ・ＨＥＲＯ サンライザー①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: summonedAs('special'),
        steps: [search('デッキから手札に加える「ミラクル・フュージョン」', { name: ['ミラクル・フュージョン'] })],
      },
      {
        label: '③ 他の自分の「ＨＥＲＯ」が戦闘を行う攻撃宣言時：フィールドのカード1枚を破壊',
        from: ['monster'],
        key: 'Ｅ・ＨＥＲＯ サンライザー③',
        limit: 1,
        speed: 2,
        targets: true,
        condition: (env) => (env.state.battle ? null : '攻撃宣言時に発動できます'),
        steps: [
          {
            op: 'pick',
            prompt: '破壊するフィールドのカード（対象）',
            target: true,
            from: ['field', 'oppField'],
            min: 1,
            max: 1,
            then: (_, p) => p.map(destroy),
          },
        ],
      },
    ],
  },

  // ミラクル・フュージョン
  '45906428': {
    effects: [
      {
        label: '発動：フィールド・墓地のモンスターを除外して「Ｅ・ＨＥＲＯ」融合モンスターを融合召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: fusionPossible(MIRACLE_FUSION),
        steps: fusionSteps(MIRACLE_FUSION),
      },
    ],
  },

  // Ｘ・ＨＥＲＯ ワンダー・ドライバー
  '1948619': {
    materialCheck: linkMaterials('素材は「ＨＥＲＯ」モンスター2体です', isHero),
    effects: [
      {
        label:
          '① リンク先に「ＨＥＲＯ」が召喚・特殊召喚された場合：墓地の「融合」「フュージョン」魔法・「チェンジ」速攻魔法を1枚セット',
        from: ['monster'],
        key: 'Ｘ・ＨＥＲＯ ワンダー・ドライバー①',
        limit: 1,
        trigger: true,
        targets: true,
        condition: (env) => {
          const arrived = linkedMonsters(env, env.self).some((u) => {
            const inst = env.state.cards[u];
            return isHero(env, u) && inst.summonedTurn === env.state.turn && inst.summonedEntry === inst.entryId;
          });
          if (!arrived) return 'このターン、リンク先に「ＨＥＲＯ」モンスターが召喚・特殊召喚されていません';
          return env.state.gy.some((u) => isFusionOrChangeSpell(env, u))
            ? null
            : '墓地に「融合」「フュージョン」魔法・「チェンジ」速攻魔法がありません';
        },
        steps: [
          {
            op: 'pick',
            prompt: 'セットする墓地の「融合」「フュージョン」魔法・「チェンジ」速攻魔法（対象）',
            target: true,
            from: ['gy'],
            where: isFusionOrChangeSpell,
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'place',
            prompt: 'セットするゾーンを選択',
            zone: 'stz',
            then: (env, z) => [
              move(env.picks![0][0], z, 'Ｘ・ＨＥＲＯ ワンダー・ドライバーの効果でセット', { faceUp: false }),
            ],
          },
        ],
      },
      {
        label: '② 戦闘・相手の効果で破壊され墓地へ送られた：手札の「ＨＥＲＯ」を特殊召喚',
        from: ['gy'],
        key: 'Ｘ・ＨＥＲＯ ワンダー・ドライバー②',
        limit: 1,
        trigger: true,
        condition: destroyedThisTurn,
        steps: [
          {
            op: 'pick',
            prompt: '手札から特殊召喚する「ＨＥＲＯ」モンスター',
            from: ['hand'],
            filter: HERO_MONSTER,
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'Ｘ・ＨＥＲＯ ワンダー・ドライバーの効果')],
          },
        ],
      },
    ],
  },

  // Ｅ・ＨＥＲＯ フレイム・ウィングマン－フレイム・シュート
  '93347961': {
    materialCheck: fusionCheck('93347961'),
    effects: [
      {
        label: '① 特殊召喚した場合：デッキ・墓地から「フェイバリット」カードを手札に加える',
        from: ['monster'],
        key: 'Ｅ・ＨＥＲＯ フレイム・ウィングマン－フレイム・シュート①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: summonedAs('special'),
        steps: [
          search('デッキ・墓地から手札に加える「フェイバリット」カード', { archetype: 'フェイバリット' }, undefined, [
            'deck',
            'gy',
          ]),
        ],
      },
      {
        label:
          '② 通常モンスターを素材に融合召喚したこのカードをリリース：デッキ・EXデッキからレベル7以下の「Ｅ・ＨＥＲＯ」を召喚条件を無視して特殊召喚',
        from: ['monster'],
        key: 'Ｅ・ＨＥＲＯ フレイム・ウィングマン－フレイム・シュート②',
        limit: 1,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          if (inst.summonType !== 'fusion') return '融合召喚したこのカードでないと発動できません';
          return (inst.materials ?? []).some((u) => env.def(u).frame === 'normal')
            ? null
            : '通常モンスターを素材に融合召喚していません';
        },
        steps: [
          { op: 'do', cost: true, then: (env) => [toGy(env.self, 'リリース')] },
          {
            op: 'pick',
            // カードのテキストでは「通常召喚できない」Ｅ・ＨＥＲＯだけ。友達のルートに合わせて、通常召喚できるものも選べる
            prompt:
              'デッキ・EXデッキから特殊召喚するレベル7以下の「Ｅ・ＨＥＲＯ」（本来は通常召喚できないものだけ。ルート練習用に通常召喚できるものも選べます）',
            from: ['deck', 'extra'],
            filter: { kind: ['monster'], archetype: E_HERO, maxLevel: 7 },
            min: 1,
            max: 1,
            zone: 'monster',
            noSummonCheck: true,
            then: (env, p, z) =>
              withShuffle(env, p, [
                ss(p[0], z, 'Ｅ・ＨＥＲＯ フレイム・ウィングマン－フレイム・シュートの効果', {
                  ignoreConditions: true,
                }),
              ]),
          },
        ],
      },
    ],
  },

  // フェイバリット・コンタクト
  '75047173': {
    effects: [
      {
        label:
          '発動：手札・フィールド・墓地・除外状態の融合素材をデッキの下に戻し、「ＨＥＲＯ」を素材とする融合モンスターを召喚条件を無視して特殊召喚',
        from: ['spelltrap'],
        isCardActivation: true,
        condition: (env) =>
          env.state.extra.some((t) => favoriteTargetPossible(env, t))
            ? null
            : '特殊召喚できる融合モンスターと素材の組み合わせがありません',
        steps: [
          {
            op: 'pick',
            prompt: 'EXデッキから特殊召喚する、「ＨＥＲＯ」モンスターを融合素材とする融合モンスター',
            from: ['extra'],
            where: favoriteTargetPossible,
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: 'デッキの下に戻す融合素材 → 出すゾーンを選択',
            from: FAVORITE_FROM,
            where: (env, u) => {
              const target = env.picks?.[0]?.[0];
              return !!target && env.def(u).kind === 'monster' && FUSION[env.def(target).id].candidate(env, u);
            },
            range: (env) => {
              const target = env.picks?.[0]?.[0];
              return target ? FUSION[env.def(target).id].range : [1, 1];
            },
            zone: 'monster',
            noSummonCheck: true,
            then: (env, p, z) => {
              const target = env.picks![0][0];
              const err = FUSION[env.def(target).id].check(env, p);
              if (err) return [fail(err)];
              return [
                ...p.map((u) => move(u, { zone: 'deck' }, 'フェイバリット・コンタクトの効果', { toBottom: true })),
                ss(target, z, 'フェイバリット・コンタクトの効果', { ignoreConditions: true }),
              ];
            },
          },
        ],
      },
    ],
  },

  // Ｍ・ＨＥＲＯ ファーネス
  '58288218': {
    effects: [
      {
        label: '① 手札から見せる：デッキから「マスク・チェンジ」か「融合」を手札に加え、手札を1枚捨てる',
        from: ['hand'],
        key: 'Ｍ・ＨＥＲＯ ファーネス①',
        limit: 1,
        condition: mainPhase,
        steps: [
          lockStep('Ｍ・ＨＥＲＯ ファーネス', false),
          search('デッキから手札に加える「マスク・チェンジ」か「融合」', { name: ['マスク・チェンジ', '融合'] }),
          {
            op: 'pick',
            prompt: '捨てる手札（このカードも選べる）',
            from: ['hand'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '効果で捨てる')),
          },
        ],
      },
      {
        label:
          '② 自分が炎属性以外の「ＨＥＲＯ」融合モンスターを特殊召喚した場合：手札・墓地から特殊召喚（離れたら除外）',
        from: ['hand', 'gy'],
        key: 'Ｍ・ＨＥＲＯ ファーネス②',
        limit: 1,
        trigger: true,
        condition: (env) =>
          ownFaceUpMonsters(env).some((u) => {
            const inst = env.state.cards[u];
            return (
              env.def(u).frame === 'fusion' &&
              isHero(env, u) &&
              env.def(u).attribute !== '炎' &&
              inst.summonedTurn === env.state.turn &&
              inst.summonedEntry === inst.entryId
            );
          })
            ? null
            : 'このターン、炎属性以外の「ＨＥＲＯ」融合モンスターを特殊召喚していません',
        steps: [ssSelf('自身の効果', { banishOnLeave: true })],
      },
    ],
  },
};
