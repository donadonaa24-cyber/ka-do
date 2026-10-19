import { type Action, candidates, effectSummonError, type MonsterLocation, oppMonsterSlots } from '../engine/game';
import type { CardFilter } from '../engine/filters';
import type { CardScript, EffectDef, Env, Step } from '../engine/scripts';
import type { CardDef, Location } from '../engine/types';

// ブルーアイズデッキのカードの召喚条件・効果。相手がいる時だけ意味がある効果は、記録するだけにする。

const BE = '青眼の白龍';

// ===== 部品 =====

const move = (
  uid: string,
  to: Location,
  reason?: string,
  extra: Partial<Extract<Action, { type: 'MOVE' }>> = {},
): Action => ({ type: 'MOVE', uid, to, reason, ...extra });
const toHand = (uid: string, reason = '効果') => move(uid, { zone: 'hand' }, reason);
const toGy = (uid: string, reason = 'コスト') => move(uid, { zone: 'gy' }, reason);
const ss = (uid: string, zone: Location | null, note: string, position: 'atk' | 'def' = 'atk'): Action => ({
  type: 'SPECIAL_SUMMON',
  uid,
  to: zone as MonsterLocation,
  position,
  note,
});
const shuffle: Action = { type: 'SHUFFLE_DECK' };
const withShuffle = (env: Env, picked: string[], actions: Action[]): Action[] =>
  picked.some((u) => env.loc(u)?.zone === 'deck') ? [...actions, shuffle] : actions;

const mainPhase = (env: Env) =>
  env.state.phase === 'M1' || env.state.phase === 'M2' ? null : 'メインフェイズにのみ発動できます';
const firstEmptyStz = (env: Env): Location => ({ zone: 'stz', index: Math.max(0, env.state.stz.indexOf(null)) });
const hasFreeStz = (env: Env) => (env.state.stz.includes(null) ? null : '魔法＆罠ゾーンに空きがありません');

const selfTo = (zone: 'gy' | 'banished', reason = 'コスト'): Step => ({
  op: 'do',
  cost: reason === 'コスト',
  then: (env) => [move(env.self, { zone }, reason)],
});
const ssSelf = (note: string, position: 'atk' | 'def' = 'atk'): Step => ({
  op: 'place',
  prompt: 'このカードを出すゾーンを選択',
  zone: 'monster',
  then: (env, zone) => [ss(env.self, zone, note, position)],
});
const search = (prompt: string, filter: CardFilter, where?: (env: Env, uid: string) => boolean): Step => ({
  op: 'pick',
  prompt,
  from: ['deck'],
  filter,
  where,
  min: 1,
  max: 1,
  then: (env, p) =>
    withShuffle(
      env,
      p,
      p.map((u) => toHand(u, 'サーチ')),
    ),
});
const discardCost = (prompt = 'コスト：捨てる手札'): Step => ({
  op: 'pick',
  cost: true,
  prompt,
  from: ['hand'],
  where: (env, u) => u !== env.self,
  min: 1,
  max: 1,
  then: (_, p) => p.map((u) => toGy(u)),
});

/** 相手が関わる効果（一人回しでは記録のみ） */
const logOnly = (label: string, from: EffectDef['from'], key?: string, cost: Step[] = []): EffectDef => ({
  label,
  from,
  key,
  limit: key ? 1 : undefined,
  opponentOnly: true,
  speed: 2,
  steps: cost,
});
const trapLogOnly = (label: string): EffectDef => ({
  ...logOnly(label, ['hand', 'spelltrap']),
  isCardActivation: true,
});

// ===== 条件 =====

const LIGHT_LV1_TUNER: CardFilter = { kind: ['monster'], attribute: ['光'], minLevel: 1, maxLevel: 1, tuner: true };
const BLUE_EYES: CardFilter = { kind: ['monster'], archetype: 'ブルーアイズ' };
const isBE = (env: Env, u: string) => env.def(u).name === BE;
const isEffectMonster = (d: CardDef) => d.kind === 'monster' && d.frame !== 'normal' && d.frame !== 'token';
const onField = (env: Env, u: string) => ['mz', 'emz'].includes(env.loc(u)?.zone ?? '');
const ownFaceUpMonsters = (env: Env) =>
  [...env.state.mz, ...env.state.emz].filter((u): u is string => !!u && env.state.cards[u].faceUp);
/** 通常モンスター（白き霊龍は手札・墓地では通常モンスター扱い） */
const isNormal = (env: Env, u: string) => {
  const d = env.def(u);
  if (d.kind !== 'monster') return false;
  if (d.frame === 'normal') return true;
  return !!d.normalInHandGy && ['hand', 'gy'].includes(env.loc(u)?.zone ?? '');
};
/** 「青眼の白龍」のカード名が記された魔法・罠 */
const mentionsBE = (d: CardDef) => d.kind !== 'monster' && d.text.includes(`「${BE}」`);

/** このカードが墓地に来た後に「青眼の白龍」を特殊召喚した（白き乙女②・カイバーマン②の条件） */
const beSpecialSummonedSince = (env: Env) => {
  const since = env.state.cards[env.self].movedAt;
  return ownFaceUpMonsters(env).some((u) => {
    const inst = env.state.cards[u];
    return (
      isBE(env, u) &&
      inst.enteredTurn === env.state.turn &&
      inst.summonedEntry === inst.entryId &&
      inst.summonType !== 'normal' &&
      inst.entryId > since
    );
  })
    ? null
    : 'このカードが墓地に送られた後に「青眼の白龍」を特殊召喚していません';
};

/** 相手の場のカード（練習用に置いたもの） */
const oppMonsters = (env: Env) => (env.state.opp ? oppMonsterSlots(env.state.opp) : []).filter((u): u is string => !!u);
const oppSpellTraps = (env: Env) =>
  [...(env.state.opp?.stz ?? []), env.state.opp?.fz ?? null].filter((u): u is string => !!u);
const needOppMonsters = (env: Env) =>
  oppMonsters(env).length ? null : '相手フィールドにモンスターがいません（相手の盤面を置くと使えます）';
const needOppSpellTraps = (env: Env) =>
  oppSpellTraps(env).length ? null : '相手フィールドに魔法・罠がありません（相手の盤面を置くと使えます）';
const destroyAll = (uids: string[]): Action[] => uids.map((u) => toGy(u, '効果で破壊'));
const noFaceUpOwn = (env: Env) =>
  [...env.state.mz, ...env.state.emz, ...env.state.stz, env.state.fz].some(
    (u) => u && u !== env.self && env.state.cards[u].faceUp,
  )
    ? '自分フィールドに表側表示のカードがあると発動できません'
    : null;

/** 自分のフィールドか墓地に「青眼の白龍」がある */
const beOnFieldOrGy = (env: Env) => [...ownFaceUpMonsters(env), ...env.state.gy].some((u) => isBE(env, u));

/** このターンにフィールドから墓地へ送られた */
const sentFromFieldThisTurn = (env: Env) => {
  const inst = env.state.cards[env.self];
  return inst.movedTurn === env.state.turn && ['mz', 'emz'].includes(inst.movedFrom ?? '')
    ? null
    : 'このターンにフィールドから墓地へ送られていません';
};

/** 今のチェーンの一番上が、フィールドのカードを対象にとる効果 */
const chainTopTargets = (env: Env) => {
  const top = env.state.chain[env.state.chain.length - 1];
  const effect = top ? env.ctx.scripts?.[top.defId]?.effects?.[top.effect] : undefined;
  return effect?.targets ? null : 'フィールドのカードを対象にとる効果が発動していません';
};

// ===== 融合素材 =====

/** 融合モンスターの素材の条件（1枚ずつの候補と、組み合わせの判定） */
interface FusionRecipe {
  range: [number, number];
  candidate: (env: Env, u: string) => boolean;
  check: (env: Env, m: string[]) => string | null;
}

const isChaosRitual = (env: Env, u: string) =>
  env.def(u).frame === 'ritual' && !!env.def(u).archetypes?.includes('カオス');

const FUSION: Record<string, FusionRecipe> = {
  // 青眼の究極竜
  '23995346': {
    range: [3, 3],
    candidate: isBE,
    check: (env, m) => (m.length === 3 && m.every((u) => isBE(env, u)) ? null : '「青眼の白龍」3体が必要です'),
  },
  // 神を超えたしもべ－青眼の究極竜
  'custom-gods-servant-blue-eyes-ultimate': {
    range: [3, 3],
    candidate: isBE,
    check: (env, m) => (m.length === 3 && m.every((u) => isBE(env, u)) ? null : '「青眼の白龍」3体が必要です'),
  },
  // 青眼の双爆裂龍
  '2129638': {
    range: [2, 2],
    candidate: isBE,
    check: (env, m) => (m.length === 2 && m.every((u) => isBE(env, u)) ? null : '「青眼の白龍」2体が必要です'),
  },
  // ブルーアイズ・タイラント・ドラゴン
  '11443677': {
    range: [2, 2],
    candidate: (env, u) => env.def(u).race === 'ドラゴン族',
    check: (env, m) => {
      if (m.length !== 2) return '融合素材は2体です';
      const [a, b] = m;
      const ok = (x: string, y: string) => isBE(env, x) && env.def(y).race === 'ドラゴン族';
      return ok(a, b) || ok(b, a) ? null : '「青眼の白龍」＋ドラゴン族モンスターが必要です';
    },
  },
  // 究極竜魔導師
  '12381100': {
    range: [2, 4],
    candidate: (env, u) => env.matches(u, BLUE_EYES) || isChaosRitual(env, u),
    check: (env, m) => {
      const chaos = m.filter((u) => isChaosRitual(env, u));
      const rest = m.filter((u) => !chaos.includes(u));
      if (chaos.length < 1) return '「カオス」儀式モンスターが必要です';
      // カオス儀式が2体なら片方をブルーアイズ側として数える
      const others = chaos.length > 1 ? [...rest, ...chaos.slice(1)] : rest;
      if (others.length === 1 && env.def(others[0]).name === '青眼の究極竜') return null;
      if (others.length === 3 && others.every((u) => env.matches(u, BLUE_EYES))) return null;
      return '「青眼の究極竜」（または「ブルーアイズ」モンスター×3）＋「カオス」儀式モンスターが必要です';
    },
  },
};

interface FusionOpts {
  by: string;
  from: ('hand' | 'monsters' | 'gy')[];
  materialsTo: 'gy' | 'deck';
  monster: (env: Env, uid: string) => boolean;
  materials?: (env: Env, m: string[]) => string | null;
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

/** 今の手札・フィールド・墓地で融合召喚できる組み合わせがあるか（なければ発動できない） */
const fusionTargetPossible = (env: Env, opts: FusionOpts, t: string): boolean => {
  const recipe = FUSION[env.def(t).id];
  if (!recipe || env.def(t).frame !== 'fusion' || !opts.monster(env, t)) return false;
  if (effectSummonError(env.state, env.ctx, t, 'fusion')) return false;
  const mats = candidates(env.state, opts.from).filter(
    (u) => u !== env.self && env.def(u).kind === 'monster' && recipe.candidate(env, u),
  );
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

/** 効果による融合召喚：融合モンスターを選び、素材を選ぶ（2ステップ） */
const fusionSteps = (opts: FusionOpts): Step[] => [
  {
    op: 'pick',
    prompt: 'EXデッキから融合召喚する融合モンスター',
    from: ['extra'],
    filter: { kind: ['monster'], frame: ['fusion'] },
    // 今の手札・フィールド・墓地で素材がそろうものだけ
    where: (env, u) => fusionTargetPossible(env, opts, u),
    min: 1,
    max: 1,
    then: () => [],
  },
  {
    op: 'pick',
    prompt: `融合素材（${opts.materialsTo === 'deck' ? 'デッキに戻す' : '墓地へ送る'}）→ 出すゾーンを選択`,
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
      // 素材の組み合わせが合わない場合は、融合召喚が失敗する操作にしてエラーを出す
      if (err) return [{ type: 'FAIL', message: err }];
      return [
        {
          type: 'PROCEDURE_SUMMON',
          method: 'fusion',
          uid: target,
          materials: p,
          to: z as MonsterLocation,
          materialsTo: opts.materialsTo,
          materialZones: opts.from.map((f) => (f === 'monsters' ? 'field' : f)),
          by: opts.by,
        },
      ];
    },
  },
];

const ULTIMATE_FUSION: FusionOpts = {
  by: '究極融合',
  from: ['hand', 'monsters', 'gy'],
  materialsTo: 'deck',
  monster: (env, u) => /青眼の白龍|青眼の究極竜/.test(env.def(u).materialText ?? ''),
};
const ROAR_FUSION: FusionOpts = {
  by: '青眼龍轟臨',
  from: ['hand', 'monsters'],
  materialsTo: 'gy',
  monster: () => true,
  materials: (env, m) =>
    m.some((u) => env.matches(u, BLUE_EYES)) ? null : '「ブルーアイズ」モンスターを含める必要があります',
};

const fusionCheck = (id: string) => (env: Env, m: string[], method: string) =>
  method === 'fusion' ? FUSION[id].check(env, m) : 'このカードは融合召喚でしか特殊召喚できません';

// ===== カードごとの召喚条件・効果 =====

export const BLUE_SCRIPTS: Record<string, CardScript> = {
  // 白き霊龍
  '45467446': {
    effects: [
      {
        label: '② 召喚・特殊召喚時：相手の魔法・罠1枚を除外',
        from: ['monster'],
        onSummon: true,
        condition: needOppSpellTraps,
        steps: [
          {
            op: 'pick',
            prompt: '除外する相手フィールドの魔法・罠（対象）',
            from: ['oppSpelltraps'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => move(u, { zone: 'banished' }, '効果で除外')),
          },
        ],
      },
      {
        label: '③ 相手フィールドにモンスターがいる時：リリースして手札の「青眼の白龍」を特殊召喚',
        from: ['monster'],
        speed: 2,
        condition: needOppMonsters,
        steps: [
          { op: 'do', cost: true, then: (env) => [toGy(env.self, 'リリース')] },
          {
            op: 'pick',
            prompt: '手札から特殊召喚する「青眼の白龍」',
            from: ['hand'],
            filter: { name: [BE] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, '白き霊龍の効果')],
          },
        ],
      },
    ],
  },

  // 青き眼の賢士
  '8240199': {
    effects: [
      {
        label: '① 召喚時：デッキから「青き眼の賢士」以外の光属性・レベル1チューナーを手札に加える',
        from: ['monster'],
        onSummon: true,
        condition: (env) => (env.state.cards[env.self].summonType === 'normal' ? null : '召喚した時のみ発動できます'),
        steps: [
          search('デッキから手札に加える光属性・レベル1チューナー', {
            ...LIGHT_LV1_TUNER,
            excludeName: ['青き眼の賢士'],
          }),
        ],
      },
      {
        label: '② 手札から捨て、自分の効果モンスターを墓地へ送り、デッキから「ブルーアイズ」を特殊召喚',
        from: ['hand'],
        key: '青き眼の賢士②',
        limit: 1,
        targets: true,
        condition: mainPhase,
        steps: [
          selfTo('gy'),
          {
            op: 'pick',
            prompt: '墓地へ送る自分フィールドの効果モンスター（対象）',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && isEffectMonster(env.def(u)),
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '効果')),
          },
          {
            op: 'pick',
            prompt: 'デッキから特殊召喚する「ブルーアイズ」モンスター',
            from: ['deck'],
            filter: BLUE_EYES,
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, '青き眼の賢士の効果')]),
          },
        ],
      },
      {
        // よく使う組み合わせ：賢士②で白き乙女を対象にし、乙女③をチェーンする（チェーン2の乙女③から処理する）
        label: '② 白き乙女を対象に発動し、白き乙女③をチェーン（墓地から青眼→デッキからブルーアイズ）',
        from: ['hand'],
        key: '青き眼の賢士②',
        limit: 1,
        condition: (env) =>
          mainPhase(env) ??
          (env.state.effectUses['白き乙女③']
            ? '白き乙女③はこのターン使用済みです'
            : ownFaceUpMonsters(env).some((u) => env.def(u).name === '白き乙女')
              ? null
              : '自分フィールドに白き乙女がいません'),
        steps: [
          selfTo('gy'),
          {
            op: 'pick',
            prompt: '対象にする自分フィールドの白き乙女',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && env.def(u).name === '白き乙女',
            min: 1,
            max: 1,
            then: (_, p) => [
              {
                type: 'ACTIVATE_EFFECT',
                uid: p[0],
                label: '③ 対象になった時：墓地から特殊召喚',
                key: '白き乙女③',
                limit: 1,
              },
            ],
          },
          {
            op: 'pick',
            prompt: 'チェーン2（白き乙女③）：墓地から特殊召喚する「青眼の白龍」か光属性・レベル1チューナー',
            from: ['gy'],
            where: (env, u) => isBE(env, u) || env.matches(u, LIGHT_LV1_TUNER),
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, '白き乙女の効果')],
          },
          {
            op: 'do',
            then: (env) => [toGy(env.picks![0][0], 'チェーン1（青き眼の賢士②）の処理')],
          },
          {
            op: 'pick',
            prompt: 'チェーン1（青き眼の賢士②）：デッキから特殊召喚する「ブルーアイズ」モンスター',
            from: ['deck'],
            filter: BLUE_EYES,
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, '青き眼の賢士の効果')]),
          },
        ],
      },
    ],
  },

  // 白き乙女
  '17947697': {
    effects: [
      {
        label: '① 手札・フィールドから墓地へ送り、「真の光」を魔法＆罠ゾーンに表側で置く',
        from: ['hand', 'monster'],
        key: '白き乙女①',
        limit: 1,
        condition: hasFreeStz,
        steps: [
          selfTo('gy'),
          {
            op: 'pick',
            prompt: '表側で置く「真の光」（手札・デッキ・墓地）',
            from: ['hand', 'deck', 'gy'],
            filter: { name: ['真の光'] },
            min: 1,
            max: 1,
            zone: 'stz',
            then: (env, p, z) =>
              withShuffle(env, p, [move(p[0], z ?? firstEmptyStz(env), '表側で置く', { faceUp: true })]),
          },
        ],
      },
      {
        label: '② 墓地にある状態で「青眼の白龍」を特殊召喚した時：このカードを特殊召喚',
        trigger: true,
        from: ['gy'],
        key: '白き乙女②',
        limit: 1,
        condition: beSpecialSummonedSince,
        steps: [ssSelf('白き乙女の効果')],
      },
      {
        label: '③ 対象になった時：墓地から「青眼の白龍」か光属性・レベル1チューナーを特殊召喚',
        from: ['monster'],
        key: '白き乙女③',
        limit: 1,
        speed: 2,
        condition: chainTopTargets,
        steps: [
          {
            op: 'pick',
            prompt: '墓地から特殊召喚する「青眼の白龍」か光属性・レベル1チューナー',
            from: ['gy'],
            where: (env, u) => isBE(env, u) || env.matches(u, LIGHT_LV1_TUNER),
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, '白き乙女の効果')],
          },
        ],
      },
    ],
  },

  // ネオ・カイザー・シーホース
  '54332792': {
    effects: [
      {
        label: '① 「青眼の白龍」がいる時：手札から特殊召喚',
        from: ['hand'],
        key: 'ネオ・カイザー・シーホース①',
        limit: 1,
        condition: (env) =>
          mainPhase(env) ??
          (ownFaceUpMonsters(env).some((u) => isBE(env, u)) ? null : '自分フィールドに「青眼の白龍」が必要です'),
        steps: [ssSelf('自身の効果')],
      },
      {
        label: '② 自分の光属性チューナーのレベルを1つ上げるか下げる',
        from: ['monster'],
        key: 'ネオ・カイザー・シーホース②',
        limit: 1,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: 'レベルを変える自分フィールドの光属性チューナー',
            from: ['monsters'],
            filter: { kind: ['monster'], attribute: ['光'], tuner: true },
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            modes: ['レベルを1つ上げる', 'レベルを1つ下げる'],
            then: (env, p, _, mode) =>
              mode === 1 && (env.def(p[0]).level ?? 0) + env.state.cards[p[0]].levelMod <= 1
                ? []
                : [{ type: 'LEVEL_MOD', uid: p[0], delta: mode === 0 ? 1 : -1 }],
          },
        ],
      },
      {
        label: '③ フィールドから墓地へ送られた時：デッキから「ブルーアイズ」か「青眼の白龍」記載モンスターを墓地へ',
        trigger: true,
        from: ['gy'],
        key: 'ネオ・カイザー・シーホース③',
        limit: 1,
        condition: sentFromFieldThisTurn,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから墓地へ送る「ブルーアイズ」モンスターか「青眼の白龍」記載モンスター',
            from: ['deck'],
            filter: { kind: ['monster'], excludeName: ['ネオ・カイザー・シーホース'] },
            where: (env, u) => env.matches(u, BLUE_EYES) || env.def(u).text.includes(`「${BE}」`),
            min: 1,
            max: 1,
            then: (env, p) => withShuffle(env, p, [toGy(p[0], '効果')]),
          },
        ],
      },
    ],
  },

  // 正義の伝説 カイバーマン
  '67768675': {
    effects: [
      {
        label: '① 召喚・特殊召喚時：「青眼の白龍」3枚を見せ、手札・デッキ・墓地から「青眼の白龍」を特殊召喚',
        from: ['monster'],
        onSummon: true,
        key: '正義の伝説 カイバーマン①',
        limit: 1,
        condition: (env) => {
          const s = env.state;
          const all = [...s.hand, ...s.deck, ...s.gy, ...ownFaceUpMonsters(env)].filter((u) => isBE(env, u));
          return all.length >= 3 ? null : '「青眼の白龍」が3枚必要です（手札・デッキ・フィールド・墓地）';
        },
        steps: [
          {
            op: 'pick',
            prompt: '特殊召喚する「青眼の白龍」（手札・デッキ・墓地）',
            from: ['hand', 'deck', 'gy'],
            filter: { name: [BE] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, 'カイバーマンの効果')]),
          },
        ],
      },
      {
        label: '② 墓地にある状態で「青眼の白龍」を特殊召喚した時：除外してデッキから「ブルーアイズ」を手札に加える',
        trigger: true,
        from: ['gy'],
        key: '正義の伝説 カイバーマン②',
        limit: 1,
        condition: beSpecialSummonedSince,
        steps: [selfTo('banished'), search('デッキから手札に加える「ブルーアイズ」モンスター', BLUE_EYES)],
      },
    ],
  },

  // 白き幻獣－青眼の白龍
  '30397786': {
    effects: [
      {
        label: '① デッキから手札に加わった時：見せて特殊召喚',
        from: ['hand'],
        key: '白き幻獣－青眼の白龍①',
        limit: 1,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          return inst.movedTurn === env.state.turn && inst.movedFrom === 'deck'
            ? null
            : 'このターンにデッキから手札に加わったカードではありません';
        },
        steps: [ssSelf('自身の効果')],
      },
      {
        label: '② 手札・デッキから特殊召喚した時：相手モンスターを全て破壊',
        from: ['monster'],
        onSummon: true,
        key: '白き幻獣－青眼の白龍②',
        limit: 1,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          if (inst.summonType === 'normal' || !['hand', 'deck'].includes(inst.movedFrom ?? ''))
            return '手札・デッキから特殊召喚した時のみ発動できます';
          return needOppMonsters(env);
        },
        steps: [{ op: 'do', then: (env) => destroyAll(oppMonsters(env)) }],
      },
      logOnly('③ 対象をとる効果を手札1枚捨てて無効（相手用）', ['monster']),
    ],
  },

  // 蒼の深淵 ディープアイズ・ホワイト・ドラゴン
  '67886895': {
    effects: [
      {
        label: '① 手札から捨てて、デッキから光属性・レベル1チューナーを手札に加える',
        from: ['hand'],
        key: '蒼の深淵 ディープアイズ・ホワイト・ドラゴン①',
        limit: 1,
        steps: [selfTo('gy'), search('デッキから手札に加える光属性・レベル1チューナー', LIGHT_LV1_TUNER)],
      },
      {
        label:
          '② 「青眼の白龍」かブルーアイズ儀式が墓地へ送られた時：手札・墓地から特殊召喚（攻撃力はそのモンスターと同じ）',
        trigger: true,
        from: ['hand', 'gy'],
        key: '蒼の深淵 ディープアイズ・ホワイト・ドラゴン②',
        limit: 1,
        condition: (env) =>
          env.state.gy.some((u) => u !== env.self && sentThisTurnBlueEyesTarget(env, u))
            ? null
            : 'このターンに「青眼の白龍」かブルーアイズ儀式モンスターが墓地へ送られていません',
        steps: [
          {
            op: 'pick',
            prompt: '対象にする、墓地へ送られた「青眼の白龍」かブルーアイズ儀式モンスター → 出すゾーンを選択',
            from: ['gy'],
            where: (env, u) => u !== env.self && sentThisTurnBlueEyesTarget(env, u),
            min: 1,
            max: 1,
            zone: 'monster',
            noSummonCheck: true,
            then: (env, p, z) => [
              ss(env.self, z, `攻撃力${env.def(p[0]).atk ?? 0}・フィールドを離れると除外`),
              { type: 'STAT_MOD', uid: env.self, setAtk: env.def(p[0]).atk ?? 0 },
            ],
          },
        ],
      },
    ],
  },

  // 聖王女ローズパメラ
  '65302903': {
    effects: [
      logOnly('① 相手ターンに見せて「ドミナス・パージ」をサーチ（相手用）', ['hand'], '聖王女ローズパメラ①'),
      {
        label: '② 召喚・特殊召喚時：デッキ・墓地から「列王」か「ドミナス・パージ」罠をセット（このターンでも発動可）',
        from: ['monster'],
        onSummon: true,
        key: '聖王女ローズパメラ②',
        limit: 1,
        condition: hasFreeStz,
        steps: [
          {
            op: 'pick',
            prompt: 'セットする「列王」罠か「ドミナス・パージ」罠（デッキ・墓地）',
            from: ['deck', 'gy'],
            filter: { kind: ['trap'] },
            // 「列王」（レジェネシス）は「聖王の粉砕」など「聖王」と書くカードも含む
            where: (env, u) => /列王|聖王|ドミナス・パージ/.test(env.def(u).name),
            min: 1,
            max: 1,
            zone: 'stz',
            then: (env, p, z) =>
              withShuffle(env, p, [move(p[0], z ?? firstEmptyStz(env), 'セット', { faceUp: false })]),
          },
        ],
      },
    ],
  },

  // ハーピィの羽根帚
  '18144506': {
    effects: [
      {
        label: '発動：相手フィールドの魔法・罠を全て破壊',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: needOppSpellTraps,
        steps: [{ op: 'do', then: (env) => destroyAll(oppSpellTraps(env)) }],
      },
    ],
  },

  // コズミック・サイクロン
  '8267140': {
    effects: [
      {
        label: '発動：1000LP払って、フィールドの魔法・罠1枚を除外',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: needOppSpellTraps,
        steps: [
          { op: 'do', cost: true, then: () => [{ type: 'CHANGE_LP', delta: -1000 }] },
          {
            op: 'pick',
            prompt: '除外するフィールドの魔法・罠（対象）',
            from: ['spelltraps', 'oppSpelltraps'],
            where: (env, u) => u !== env.self,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => move(u, { zone: 'banished' }, '効果で除外')),
          },
        ],
      },
    ],
  },

  // 光の霊堂
  '24382602': {
    effects: [
      { label: '発動', from: ['hand', 'field-zone'], isCardActivation: true, steps: [] },
      {
        label: '① 通常召喚に加えて1度だけ、光属性・レベル1チューナーを召喚できる',
        from: ['field-zone'],
        key: '光の霊堂①',
        limit: 1,
        applied: true,
        steps: [
          {
            op: 'do',
            then: () => [
              {
                type: 'GRANT_SUMMON',
                grant: {
                  source: '光の霊堂',
                  extraSummon: true,
                  noTribute: false,
                  filter: LIGHT_LV1_TUNER,
                  thisTurnOnly: true,
                },
              },
            ],
          },
        ],
      },
      {
        label: '② 手札・デッキの通常モンスターを墓地へ送り、自分のモンスター1体の攻守をアップ',
        from: ['field-zone'],
        key: '光の霊堂②',
        limit: 1,
        perCard: true,
        targets: true,
        condition: (env) =>
          !ownFaceUpMonsters(env).length
            ? '自分フィールドに表側表示のモンスターが必要です'
            : [...env.state.hand, ...env.state.deck].some((u) => isNormal(env, u))
              ? null
              : '手札・デッキに墓地へ送る通常モンスターがいません',
        steps: [
          {
            op: 'pick',
            prompt: '攻撃力・守備力を上げる自分フィールドの表側表示モンスター（対象）',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: '墓地へ送る通常モンスター（手札・デッキ）',
            from: ['hand', 'deck'],
            where: isNormal,
            min: 1,
            max: 1,
            then: (env, p) => {
              const up = (env.def(p[0]).level ?? 0) * 100;
              return withShuffle(env, p, [
                toGy(p[0], `効果（攻守${up}アップ）`),
                { type: 'STAT_MOD', uid: env.picks![0][0], atk: up, def: up, untilEnd: true, source: '光の霊堂' },
              ]);
            },
          },
        ],
      },
      {
        // よく使う組み合わせ：霊堂②で白き乙女を対象にし、乙女③をチェーンする（チェーン2の乙女③から処理するので、
        // 霊堂②で墓地へ送る通常モンスターは乙女③では蘇生できない）
        label: '② 白き乙女を対象に発動し、白き乙女③をチェーン（墓地から青眼かチューナー→通常モンスターを墓地へ）',
        from: ['field-zone'],
        key: '光の霊堂②',
        limit: 1,
        perCard: true,
        condition: (env) =>
          env.state.effectUses['白き乙女③']
            ? '白き乙女③はこのターン使用済みです'
            : !ownFaceUpMonsters(env).some((u) => env.def(u).name === '白き乙女')
              ? '自分フィールドに白き乙女がいません'
              : !env.state.gy.some((u) => isBE(env, u) || env.matches(u, LIGHT_LV1_TUNER))
                ? '墓地に「青眼の白龍」か光属性・レベル1チューナーがいません（白き乙女③で特殊召喚するモンスター）'
                : [...env.state.hand, ...env.state.deck].some((u) => isNormal(env, u))
                  ? null
                  : '手札・デッキに墓地へ送る通常モンスターがいません',
        steps: [
          {
            op: 'pick',
            prompt: '対象にする自分フィールドの白き乙女',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && env.def(u).name === '白き乙女',
            min: 1,
            max: 1,
            then: (_, p) => [
              {
                type: 'ACTIVATE_EFFECT',
                uid: p[0],
                label: '③ 対象になった時：墓地から特殊召喚',
                key: '白き乙女③',
                limit: 1,
              },
            ],
          },
          {
            op: 'pick',
            prompt: 'チェーン2（白き乙女③）：墓地から特殊召喚する「青眼の白龍」か光属性・レベル1チューナー',
            from: ['gy'],
            where: (env, u) => isBE(env, u) || env.matches(u, LIGHT_LV1_TUNER),
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, '白き乙女の効果')],
          },
          {
            op: 'pick',
            prompt: 'チェーン1（光の霊堂②）：墓地へ送る通常モンスター（手札・デッキ）',
            from: ['hand', 'deck'],
            where: isNormal,
            min: 1,
            max: 1,
            then: (env, p) => {
              const up = (env.def(p[0]).level ?? 0) * 100;
              return withShuffle(env, p, [
                toGy(p[0], `効果（白き乙女の攻守${up}アップ）`),
                { type: 'STAT_MOD', uid: env.picks![0][0], atk: up, def: up, untilEnd: true, source: '光の霊堂' },
              ]);
            },
          },
        ],
      },
    ],
  },

  // 究極融合
  '71143015': {
    effects: [
      {
        label:
          '発動：手札・フィールド・墓地の素材をデッキに戻し、「青眼の白龍」か「青眼の究極竜」を素材とする融合モンスターを融合召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: fusionPossible(ULTIMATE_FUSION),
        steps: fusionSteps(ULTIMATE_FUSION),
      },
    ],
  },

  // シンクロ・ランブル
  '88901994': {
    effects: [
      {
        label:
          '発動：墓地のチューナーかレベル7・8のドラゴン族Sモンスターを守備表示で特殊召喚（このターンEXからはSのみ）',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'pick',
            prompt: '墓地から守備表示で特殊召喚するチューナーかレベル7・8のドラゴン族Sモンスター',
            from: ['gy'],
            where: (env, u) => {
              const d = env.def(u);
              return (
                d.kind === 'monster' &&
                (!!d.tuner || (d.frame === 'synchro' && d.race === 'ドラゴン族' && [7, 8].includes(d.level ?? 0)))
              );
            },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [
              { type: 'EXTRA_LOCK', source: 'シンクロ・ランブル', filter: { frame: ['synchro'] } },
              ss(p[0], z, 'シンクロ・ランブルの効果', 'def'),
            ],
          },
        ],
      },
    ],
  },

  // 青き眼の祈り
  '80326401': {
    effects: [
      {
        label: '① 手札1枚を捨て、「青眼の白龍」記載の魔法・罠と光属性・レベル1チューナーをデッキから手札に加える',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        key: '青き眼の祈り①',
        limit: 1,
        steps: [
          discardCost(),
          search(
            'デッキから手札に加える「青眼の白龍」記載の魔法・罠（「青き眼の祈り」以外）',
            { excludeName: ['青き眼の祈り'] },
            (env, u) => mentionsBE(env.def(u)),
          ),
          search('デッキから手札に加える光属性・レベル1チューナー', LIGHT_LV1_TUNER),
        ],
      },
      {
        label: '② 墓地から除外し、自分の「青眼の白龍」にEXデッキの「ブルーアイズ」を装備（攻撃力400アップ）',
        from: ['gy'],
        key: '青き眼の祈り②',
        limit: 1,
        targets: true,
        condition: (env) =>
          hasFreeStz(env) ??
          (ownFaceUpMonsters(env).some((u) => isBE(env, u)) ? null : '自分フィールドに「青眼の白龍」が必要です'),
        steps: [
          selfTo('banished'),
          {
            op: 'pick',
            prompt: '装備先の自分フィールドの「青眼の白龍」（対象）',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && isBE(env, u),
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: '装備するEXデッキの「ブルーアイズ」モンスター',
            from: ['extra'],
            filter: BLUE_EYES,
            min: 1,
            max: 1,
            zone: 'stz',
            then: (env, p, z) => [
              move(p[0], z ?? firstEmptyStz(env), `${env.def(env.picks![0][0]).name}に装備（攻撃力400アップ）`, {
                faceUp: true,
                equipTo: env.picks![0][0],
              }),
              { type: 'STAT_MOD', uid: p[0], equip: true, atk: 400 },
            ],
          },
        ],
      },
    ],
  },

  // 青眼龍轟臨（①②は1ターンにいずれか1つ）
  '17725109': {
    effects: [
      {
        label: '① デッキ・墓地・除外の「ブルーアイズ」を守備表示で特殊召喚（青眼の白龍がいなければ青眼の白龍のみ）',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        key: '青眼龍轟臨',
        limit: 1,
        steps: [
          {
            op: 'pick',
            prompt: '守備表示で特殊召喚する「ブルーアイズ」モンスター（デッキ・墓地・除外）',
            from: ['deck', 'gy', 'banished'],
            filter: BLUE_EYES,
            where: (env, u) => isBE(env, u) || ownFaceUpMonsters(env).some((m) => isBE(env, m)),
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) =>
              withShuffle(env, p, [
                { type: 'EXTRA_LOCK', source: '青眼龍轟臨', filter: { race: ['ドラゴン族'] } },
                ss(p[0], z, '青眼龍轟臨の効果', 'def'),
              ]),
          },
        ],
      },
      {
        label: '② 墓地から除外し、「ブルーアイズ」を含む手札・フィールドのモンスターで融合召喚',
        from: ['gy'],
        key: '青眼龍轟臨',
        limit: 1,
        condition: (env) => mainPhase(env) ?? fusionPossible(ROAR_FUSION)(env),
        steps: [selfTo('banished'), ...fusionSteps(ROAR_FUSION)],
      },
    ],
  },

  // 真の光
  '62089826': {
    effects: [
      { label: '発動', from: ['spelltrap'], isCardActivation: true, steps: [] },
      {
        label: '①● 手札・墓地から「青眼の白龍」を特殊召喚',
        from: ['spelltrap'],
        key: '真の光①',
        limit: 1,
        speed: 2,
        condition: (env) => (env.state.cards[env.self].faceUp ? null : '表側表示の時に発動できます'),
        steps: [
          {
            op: 'pick',
            prompt: '特殊召喚する「青眼の白龍」（手札・墓地）',
            from: ['hand', 'gy'],
            filter: { name: [BE] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, '真の光の効果')],
          },
        ],
      },
      {
        label: '①● 「青眼の白龍」記載の魔法・罠をデッキからセット（同名カードが場・墓地に無いもの）',
        from: ['spelltrap'],
        key: '真の光①',
        limit: 1,
        speed: 2,
        condition: (env) => (env.state.cards[env.self].faceUp ? hasFreeStz(env) : '表側表示の時に発動できます'),
        steps: [
          {
            op: 'pick',
            prompt: 'デッキからセットする「青眼の白龍」記載の魔法・罠',
            from: ['deck'],
            where: (env, u) => {
              const name = env.def(u).name;
              const exists = [...env.state.stz, env.state.fz, ...env.state.gy].some(
                (x) => !!x && env.def(x).name === name,
              );
              return mentionsBE(env.def(u)) && !exists;
            },
            min: 1,
            max: 1,
            zone: 'stz',
            then: (env, p, z) =>
              withShuffle(env, p, [move(p[0], z ?? firstEmptyStz(env), 'セット', { faceUp: false })]),
          },
        ],
      },
    ],
  },

  // 聖王の粉砕
  '97045737': { effects: [trapLogOnly('発動：デッキから手札に加える効果を無効（相手用）')] },

  // 白き龍の威光
  '43219114': {
    effects: [
      trapLogOnly('① 「青眼の白龍」を3体まで見せ、その数だけ相手のカードを破壊（相手用）'),
      {
        label: '② 墓地から除外し、「青眼の白龍」をリリースして手札から儀式召喚',
        from: ['gy'],
        key: '白き龍の威光②',
        limit: 1,
        condition: mainPhase,
        steps: [
          selfTo('banished'),
          {
            op: 'pick',
            prompt: '儀式召喚する手札の儀式モンスター',
            from: ['hand'],
            filter: { kind: ['monster'], frame: ['ritual'] },
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            prompt: 'リリースする手札・フィールドの「青眼の白龍」（レベルの合計が儀式モンスターと同じ）→ 出すゾーン',
            from: ['hand', 'monsters'],
            filter: { name: [BE] },
            count: (env) => Math.max(1, Math.round((env.def(env.picks?.[0]?.[0] ?? env.self).level ?? 8) / 8)),
            zone: 'monster',
            noSummonCheck: true,
            then: (env, p, z) => [
              {
                type: 'PROCEDURE_SUMMON',
                method: 'ritual',
                uid: env.picks![0][0],
                materials: p,
                to: z as MonsterLocation,
                by: '白き龍の威光',
              },
            ],
          },
        ],
      },
    ],
  },

  // 列王詩篇
  '58053438': { effects: [trapLogOnly('発動：フィールドのモンスター効果を無効（相手用）')] },

  // 青眼の究極竜
  '23995346': { materialCheck: fusionCheck('23995346') },

  // 神を超えたしもべ－青眼の究極竜（①は耐性、②は3回攻撃なので発動する効果は③だけ）
  'custom-gods-servant-blue-eyes-ultimate': {
    materialCheck: fusionCheck('custom-gods-servant-blue-eyes-ultimate'),
    effects: [
      {
        ...logOnly(
          '③ バトルフェイズに、相手のこのターン特殊召喚されたモンスターか裏側カード1枚を破壊（相手用・1ターンに3度）',
          ['monster'],
          '神を超えたしもべ－青眼の究極竜③',
        ),
        limit: 3,
      },
    ],
  },

  // ブルーアイズ・タイラント・ドラゴン
  '11443677': {
    materialCheck: fusionCheck('11443677'),
    procedures: [
      {
        label: '融合モンスターを装備した「青眼の白龍」をリリース',
        hint: '融合モンスターを装備している自分の「青眼の白龍」1体を選択',
        from: ['monsters'],
        materialsTo: 'gy',
        materialsReason: 'リリース',
        summonFrom: ['extra'],
        materialFilter: (env, u) => isBE(env, u),
        validate: (env, m) =>
          m.length === 1 &&
          isBE(env, m[0]) &&
          env.state.stz.some((u) => u && env.state.cards[u].equippedTo === m[0] && env.def(u).frame === 'fusion')
            ? null
            : '融合モンスターを装備している「青眼の白龍」1体が必要です',
      },
    ],
  },

  // 究極竜魔導師
  '12381100': {
    materialCheck: fusionCheck('12381100'),
    effects: [logOnly('① 相手の効果の発動を無効にし破壊（相手用）', ['monster'])],
  },

  // 聖珖神竜 スターダスト・シフル
  '26268488': {
    materialCheck: (env, m, method) => {
      if (method !== 'synchro') return 'このカードはS召喚でしか特殊召喚できません';
      const tuners = m.filter((u) => env.def(u).tuner);
      const rest = m.filter((u) => !env.def(u).tuner);
      return tuners.every((u) => env.def(u).frame === 'synchro') &&
        rest.length >= 2 &&
        rest.every((u) => env.def(u).frame === 'synchro')
        ? null
        : 'Sモンスターのチューナー＋チューナー以外のSモンスター2体以上が必要です';
    },
    effects: [
      logOnly(
        '② 相手のモンスター効果を無効にしてカード1枚を破壊（相手用）',
        ['monster'],
        '聖珖神竜 スターダスト・シフル②',
      ),
    ],
  },

  // 青眼の精霊龍
  '59822133': {
    materialCheck: (env, m) =>
      m.filter((u) => !env.def(u).tuner).every((u) => env.matches(u, BLUE_EYES))
        ? null
        : 'チューナー以外は「ブルーアイズ」モンスターのみです',
    effects: [
      logOnly('② 墓地のカードの効果の発動を無効（相手用）', ['monster']),
      {
        label: '③ S召喚したこのカードをリリースし、EXからドラゴン族・光属性Sモンスターを守備表示で特殊召喚',
        from: ['monster'],
        key: '青眼の精霊龍③',
        limit: 1,
        perCard: true,
        speed: 2,
        condition: (env) =>
          env.state.cards[env.self].summonType === 'synchro' ? null : 'S召喚したこのカードでのみ発動できます',
        steps: [
          { op: 'do', cost: true, then: (env) => [move(env.self, { zone: 'gy' }, 'リリース')] },
          {
            op: 'pick',
            prompt: 'EXデッキから守備表示で特殊召喚するドラゴン族・光属性Sモンスター（エンドフェイズに破壊）',
            from: ['extra'],
            filter: {
              kind: ['monster'],
              frame: ['synchro'],
              race: ['ドラゴン族'],
              attribute: ['光'],
              excludeName: ['青眼の精霊龍'],
            },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [
              { ...ss(p[0], z, '青眼の精霊龍の効果・エンドフェイズに破壊', 'def'), destroyAtEnd: true } as Action,
            ],
          },
        ],
      },
    ],
  },

  // 天球の聖刻印
  '24361622': {
    materialCheck: (env, m) =>
      m.length === 2 && m.every((u) => env.def(u).race === 'ドラゴン族') ? null : 'ドラゴン族モンスター2体が必要です',
    effects: [
      {
        label: '① 相手ターン：手札・フィールドのモンスター1体をリリースし、フィールドの表側カード1枚を手札に戻す',
        from: ['monster'],
        key: '天球の聖刻印①',
        limit: 1,
        speed: 2,
        condition: (env) =>
          !env.state.opponentTurn
            ? '相手ターンにのみ発動できます（メニューの「相手ターンへ」で相手ターンに進めます）'
            : env.loc(env.self)?.zone === 'emz'
              ? null
              : 'EXモンスターゾーンにある時のみ発動できます',
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：リリースする手札・フィールドのモンスター（このカード自身なら②でドラゴン族を出せる）',
            from: ['hand', 'monsters'],
            filter: { kind: ['monster'] },
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, 'リリース')),
          },
          {
            op: 'pick',
            prompt: '手札に戻すフィールドの表側表示カード（相手の盤面を置いていれば相手のカードも選べる）',
            from: ['field'],
            where: (env, u) => env.state.cards[u].faceUp,
            min: 0,
            max: 1,
            then: (_, p) => p.map((u) => toHand(u, 'バウンス')),
          },
        ],
      },
      {
        label: '② リリースされた時：手札・デッキからドラゴン族を攻守0にして特殊召喚',
        from: ['gy'],
        key: '天球の聖刻印②',
        limit: 1,
        trigger: true,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          return inst.movedTurn === env.state.turn && inst.movedReason === 'リリース'
            ? null
            : 'このターンにリリースされていません';
        },
        steps: [
          {
            op: 'pick',
            prompt: '攻守0にして特殊召喚するドラゴン族モンスター（手札・デッキ）',
            from: ['hand', 'deck'],
            filter: { kind: ['monster'], race: ['ドラゴン族'] },
            where: (env, u) => !['ritual'].includes(env.def(u).frame ?? ''),
            min: 1,
            max: 1,
            modes: ['守備表示で特殊召喚', '攻撃表示で特殊召喚'],
            zone: 'monster',
            then: (env, p, z, mode) =>
              withShuffle(env, p, [ss(p[0], z, '天球の聖刻印の効果・攻守0', mode === 0 ? 'def' : 'atk')]),
          },
        ],
      },
    ],
  },

  // 赤き竜
  '63436931': {
    effects: [
      {
        label: '① 特殊召喚時：デッキから「赤き竜」記載の魔法・罠を手札に加える',
        from: ['monster'],
        onSummon: true,
        key: '赤き竜①',
        limit: 1,
        steps: [
          search('デッキから手札に加える「赤き竜」記載の魔法・罠', { kind: ['spell', 'trap'], mentions: '赤き竜' }),
        ],
      },
      {
        label: '② 自分のレベル7以上のSモンスターと同じレベルのドラゴン族Sを、EXに戻ってS召喚扱いで特殊召喚',
        from: ['monster'],
        key: '赤き竜②',
        limit: 1,
        speed: 2,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: '対象にする「赤き竜」以外のレベル7以上のSモンスター',
            from: ['monsters'],
            filter: { kind: ['monster'], frame: ['synchro'], minLevel: 7, excludeName: ['赤き竜'] },
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: (env) => [move(env.self, { zone: 'extra' }, 'EXデッキに戻る')],
          },
          {
            op: 'pick',
            prompt: 'S召喚扱いで特殊召喚する、対象と同じレベルのドラゴン族Sモンスター',
            from: ['extra'],
            filter: { kind: ['monster'], frame: ['synchro'], race: ['ドラゴン族'] },
            where: (env, u) => {
              const target = env.picks?.[0]?.[0];
              return (
                !!target &&
                env.def(u).level === env.def(target).level &&
                env.def(u).name !== '赤き竜' &&
                !effectSummonError(env.state, env.ctx, u, 'synchro')
              );
            },
            min: 1,
            max: 1,
            zone: 'monster',
            noSummonCheck: true,
            then: (_, p, z) => [
              { type: 'SPECIAL_SUMMON', uid: p[0], to: z as MonsterLocation, note: 'S召喚扱い', as: 'synchro' },
            ],
          },
        ],
      },
    ],
  },

  // 青眼の究極霊竜
  '89604813': {
    materialCheck: (env, m) =>
      m.filter((u) => !env.def(u).tuner).every((u) => env.matches(u, BLUE_EYES))
        ? null
        : 'チューナー以外は「ブルーアイズ」モンスター1体です',
    effects: [
      logOnly('② フィールドで発動した効果を無効（相手用）', ['monster'], '青眼の究極霊竜②'),
      {
        label: '③ 戦闘・効果で破壊された時：墓地から「青眼の究極霊竜」以外のドラゴン族・光属性モンスターを特殊召喚',
        from: ['gy'],
        key: '青眼の究極霊竜③',
        limit: 1,
        trigger: true,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          return inst.movedTurn !== null &&
            inst.movedTurn >= env.state.turn - 1 &&
            (inst.movedReason ?? '').includes('破壊') &&
            ['mz', 'emz'].includes(inst.movedFrom ?? '')
            ? null
            : '戦闘・効果で破壊されていません';
        },
        steps: [
          {
            op: 'pick',
            prompt: '墓地から特殊召喚するドラゴン族・光属性モンスター',
            from: ['gy'],
            filter: { kind: ['monster'], race: ['ドラゴン族'], attribute: ['光'], excludeName: ['青眼の究極霊竜'] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, '青眼の究極霊竜の効果')],
          },
        ],
      },
    ],
  },

  // 青き眼の精霊
  '42097666': {
    materialCheck: (env, m) => {
      const d = m.length === 1 ? env.def(m[0]) : undefined;
      return d && (d.level ?? 99) <= 4 && ['ドラゴン族', '魔法使い族'].includes(d.race ?? '')
        ? null
        : 'レベル4以下のドラゴン族・魔法使い族モンスター1体が必要です';
    },
    effects: [
      {
        label: '① L召喚時：デッキから「光の霊堂」を手札に加えるか墓地へ送る',
        from: ['monster'],
        onSummon: true,
        key: '青き眼の精霊①',
        limit: 1,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキの「光の霊堂」',
            from: ['deck'],
            filter: { name: ['光の霊堂'] },
            min: 1,
            max: 1,
            modes: ['手札に加える', '墓地へ送る'],
            then: (env, p, _, mode) => withShuffle(env, p, [mode === 0 ? toHand(p[0], 'サーチ') : toGy(p[0], '効果')]),
          },
        ],
      },
      {
        label: '③ リリースして、手札・墓地から「ブルーアイズ」を特殊召喚（墓地からなら攻撃不可・効果無効）',
        from: ['monster'],
        key: '青き眼の精霊③',
        limit: 1,
        steps: [
          { op: 'do', cost: true, then: (env) => [move(env.self, { zone: 'gy' }, 'リリース')] },
          {
            op: 'pick',
            prompt: '特殊召喚する「ブルーアイズ」モンスター（手札・墓地）',
            from: ['hand', 'gy'],
            filter: BLUE_EYES,
            where: (env, u) => env.def(u).frame !== 'ritual',
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => [
              ss(
                p[0],
                z,
                env.loc(p[0])?.zone === 'gy' ? '青き眼の精霊の効果・攻撃不可・効果無効' : '青き眼の精霊の効果',
              ),
            ],
          },
        ],
      },
    ],
  },

  // 藍眼の銀龍
  '16699558': {
    materialCheck: (env, m) =>
      m.every((u) => env.def(u).race === 'ドラゴン族') ? null : 'ドラゴン族モンスターのみ素材にできます',
    effects: [
      logOnly('① X召喚時：相手の表側カードの効果を無効（相手用）', ['monster']),
      {
        label: '③ X素材を1つ取り除き、墓地・除外の通常モンスターを特殊召喚（攻撃力1000アップ）',
        from: ['monster'],
        key: '藍眼の銀龍③',
        limit: 1,
        condition: (env) => (env.state.cards[env.self].overlay.length ? null : 'X素材がありません'),
        steps: [
          {
            op: 'do',
            cost: true,
            then: (env) => [{ type: 'DETACH', target: env.self, uid: env.state.cards[env.self].overlay[0] }],
          },
          {
            op: 'pick',
            prompt: '特殊召喚する通常モンスター（墓地・除外）',
            from: ['gy', 'banished'],
            where: isNormal,
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [
              ss(p[0], z, '藍眼の銀龍の効果・攻撃力1000アップ'),
              { type: 'STAT_MOD', uid: p[0], atk: 1000, source: '藍眼の銀龍' },
            ],
          },
        ],
      },
    ],
  },

  // ライトストーム・ドラゴン
  '10515412': {
    effects: [logOnly('① 特殊召喚時：魔法・罠を破壊（相手用）', ['monster'], 'ライトストーム・ドラゴン①')],
  },

  // 氷結界の龍胤 エクハジャール
  '65424481': {
    effects: [
      logOnly('① S召喚時：手札1枚を捨てて相手のカード2枚を除外（相手用）', ['monster'], '氷結界の龍胤 エクハジャール①'),
      logOnly('② 相手の特殊召喚時：カード1枚を手札に戻す（相手用）', ['monster'], '氷結界の龍胤 エクハジャール②'),
    ],
  },

  // ===== サイドデッキのカード =====

  // サンダー・ボルト
  '12580477': {
    effects: [
      {
        label: '発動：相手フィールドのモンスターを全て破壊',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: needOppMonsters,
        steps: [{ op: 'do', then: (env) => destroyAll(oppMonsters(env)) }],
      },
    ],
  },

  // ライトニング・ストーム
  '14532163': {
    effects: [
      {
        label: '発動●：相手の攻撃表示モンスターを全て破壊（自分の場に表側カードが無い時）',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: (env) => noFaceUpOwn(env) ?? needOppMonsters(env),
        steps: [
          {
            op: 'do',
            then: (env) =>
              destroyAll(
                oppMonsters(env).filter((u) => env.state.cards[u].faceUp && env.state.cards[u].position === 'atk'),
              ),
          },
        ],
      },
      {
        label: '発動●：相手の魔法・罠を全て破壊（自分の場に表側カードが無い時）',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: (env) => noFaceUpOwn(env) ?? needOppSpellTraps(env),
        steps: [{ op: 'do', then: (env) => destroyAll(oppSpellTraps(env)) }],
      },
    ],
  },

  // 海亀壊獣ガメシエル
  '55063751': { effects: [logOnly('① 相手モンスター1体をリリースし、相手フィールドに特殊召喚（相手用）', ['hand'])] },

  // Ｎｏ．３８ 希望魁竜タイタニック・ギャラクシー
  '63767246': {
    effects: [
      logOnly(
        '① 魔法の効果がフィールドで発動した時、無効にしてX素材にする（相手用）',
        ['monster'],
        'タイタニック・ギャラクシー①',
      ),
      logOnly('② 相手の攻撃宣言時、攻撃対象をこのカードに移す（相手用）', ['monster']),
    ],
  },

  // ドラゴン・目覚めの旋律
  '48800175': {
    effects: [
      {
        label: '発動：手札1枚を捨て、攻撃力3000以上・守備力2500以下のドラゴン族を2体までデッキから手札に加える',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          discardCost(),
          {
            op: 'pick',
            prompt: 'デッキから手札に加える、攻撃力3000以上・守備力2500以下のドラゴン族（2体まで）',
            from: ['deck'],
            filter: { kind: ['monster'], race: ['ドラゴン族'] },
            where: (env, u) => (env.def(u).atk ?? 0) >= 3000 && (env.def(u).def ?? 0) <= 2500,
            min: 1,
            max: 2,
            then: (env, p) =>
              withShuffle(
                env,
                p,
                p.map((u) => toHand(u, 'サーチ')),
              ),
          },
        ],
      },
    ],
  },

  // ビンゴマシーンＧＯ！ＧＯ！
  '93437091': {
    effects: [
      {
        label:
          '発動：「ブルーアイズ」モンスターか青眼の白龍・青眼の究極竜記載の魔法・罠を3枚見せ、相手がランダムに選んだ1枚を手札に加える',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから相手に見せるカード3枚（相手がランダムに1枚選び、それを手札に加える）',
            from: ['deck'],
            where: (env, u) => {
              const d = env.def(u);
              if (d.kind === 'monster') return env.matches(u, BLUE_EYES);
              return (
                d.name !== 'ビンゴマシーンＧＯ！ＧＯ！' &&
                (d.text.includes(`「${BE}」`) || d.text.includes('「青眼の究極竜」'))
              );
            },
            min: 3,
            max: 3,
            then: (_, p) => [{ type: 'RANDOM_TO_HAND', uids: p, reason: 'ビンゴマシーンGO!GO!' }, shuffle],
          },
        ],
      },
    ],
  },

  // 青眼の双爆裂龍
  '2129638': {
    materialCheck: fusionCheck('2129638'),
    procedures: [
      {
        label: '自分のモンスターゾーンの「青眼の白龍」2体を墓地へ送る',
        hint: '自分フィールドの「青眼の白龍」2体を選択',
        from: ['monsters'],
        materialsTo: 'gy',
        summonFrom: ['extra'],
        materialFilter: (env, u) => isBE(env, u),
        validate: (env, m) =>
          m.length === 2 && m.every((u) => isBE(env, u)) ? null : '自分のモンスターゾーンの「青眼の白龍」2体が必要です',
      },
    ],
  },

  // ブルーアイズ・ジェット・ドラゴン
  '30576089': {
    effects: [
      {
        label: '① フィールドのカードが戦闘・効果で破壊された時：手札・墓地から特殊召喚',
        from: ['hand', 'gy'],
        key: 'ブルーアイズ・ジェット・ドラゴン①',
        limit: 1,
        trigger: true,
        condition: (env) => {
          if (!beOnFieldOrGy(env)) return '自分のフィールドか墓地に「青眼の白龍」が必要です';
          const destroyed = Object.values(env.state.cards).some(
            (c) =>
              c.uid !== env.self &&
              c.movedTurn === env.state.turn &&
              (c.movedReason ?? '').includes('破壊') &&
              ['mz', 'emz', 'stz', 'fz'].includes(c.movedFrom ?? ''),
          );
          return destroyed ? null : 'このターンにフィールドのカードが破壊されていません';
        },
        steps: [ssSelf('自身の効果')],
      },
      logOnly('③ 戦闘を行うダメージステップ開始時、相手のカード1枚を手札に戻す（相手用）', ['monster']),
    ],
  },

  // エンシェント・フェアリー・ドラゴン
  '25862681': {
    effects: [
      {
        label: '① 手札からレベル4以下のモンスターを特殊召喚（このターンバトルフェイズを行えない）',
        from: ['monster'],
        key: 'エンシェント・フェアリー・ドラゴン①',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            prompt: '手札から特殊召喚するレベル4以下のモンスター',
            from: ['hand'],
            filter: { kind: ['monster'], maxLevel: 4 },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'エンシェント・フェアリー・ドラゴンの効果')],
          },
        ],
      },
      {
        label: '② フィールドゾーンのカードを全て破壊して1000LP回復し、別名のフィールド魔法をデッキから手札に加える',
        from: ['monster'],
        key: 'エンシェント・フェアリー・ドラゴン②',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'do',
            then: (env) => [
              ...(env.state.fz ? [toGy(env.state.fz, '効果で破壊')] : []),
              { type: 'CHANGE_LP', delta: 1000 },
            ],
          },
          {
            op: 'pick',
            prompt: 'デッキから手札に加えるフィールド魔法（破壊したカードと別名・任意）',
            from: ['deck'],
            filter: { kind: ['spell'], spellType: ['field'] },
            where: (env, u) => {
              const destroyed = env.state.gy[env.state.gy.length - 1];
              return (
                !destroyed || env.def(destroyed).name !== env.def(u).name || env.def(destroyed).spellType !== 'field'
              );
            },
            min: 0,
            max: 1,
            then: (env, p) =>
              withShuffle(
                env,
                p,
                p.map((u) => toHand(u, 'サーチ')),
              ),
          },
        ],
      },
    ],
  },

  // エンシェント・フェアリー・ライフ・ドラゴン
  '43321985': {
    effects: [
      {
        label: '① S召喚時：1枚ドロー（「精霊の世界」があればサーチ）',
        from: ['monster'],
        onSummon: true,
        key: 'エンシェント・フェアリー・ライフ・ドラゴン①',
        limit: 1,
        condition: (env) => (env.state.cards[env.self].summonType === 'synchro' ? null : 'S召喚した時のみ発動できます'),
        steps: [{ op: 'do', then: () => [{ type: 'DRAW', count: 1 }] }],
      },
    ],
  },
};

/** このターンに墓地へ送られた「青眼の白龍」かブルーアイズ儀式モンスター（ディープアイズ②の対象） */
function sentThisTurnBlueEyesTarget(env: Env, u: string): boolean {
  const d = env.def(u);
  const inst = env.state.cards[u];
  return (
    inst.movedTurn === env.state.turn &&
    (d.name === BE || (d.frame === 'ritual' && !!d.archetypes?.includes('ブルーアイズ'))) &&
    env.loc(u)?.zone === 'gy' &&
    !onField(env, u)
  );
}
