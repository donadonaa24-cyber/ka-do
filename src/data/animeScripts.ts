import { type Action, type MonsterLocation, oppMonsterSlots } from '../engine/game';
import type { CardScript, EffectDef, Env, Step } from '../engine/scripts';
import type { GameState, Location } from '../engine/types';
import { TG_SCRIPTS } from './tgScripts';

// アニメ版の効果を持つカード（カードの id は anime-<OCG版の id>）。素材の条件はOCG版と同じ。

const ss = (uid: string, zone: Location | null, note: string, position?: 'atk' | 'def'): Action => ({
  type: 'SPECIAL_SUMMON',
  uid,
  to: zone as MonsterLocation,
  position,
  note,
});
const fail = (message: string): Action => ({ type: 'FAIL', message });
const freeMz = (state: GameState): MonsterLocation[] =>
  state.mz.flatMap((u, index) => (u ? [] : [{ zone: 'mz' as const, index }]));
const oppTurn = (env: Env) =>
  env.state.opponentTurn ? null : '相手ターンにのみ発動できます（メニューの「相手ターンへ」で相手ターンに進めます）';
const toGy = (uid: string, reason: string): Action => ({ type: 'MOVE', uid, to: { zone: 'gy' }, reason });
/** このターン、表側表示のこのカードがフィールドを離れた */
const leftFieldThisTurn = (env: Env) => {
  const inst = env.state.cards[env.self];
  return inst.movedTurn === env.state.turn && ['mz', 'emz'].includes(inst.movedFrom ?? '')
    ? null
    : 'このターンにフィールドを離れていません';
};

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

/** EXデッキから指定したカード名のモンスターを特殊召喚する（出さなくてもよい） */
const ssFromExtra = (cardName: string, note: string, as?: 'synchro'): Step => ({
  op: 'pick',
  prompt: `EXデッキから特殊召喚する「${cardName}」（出さないなら選ばずに決定）`,
  from: ['extra'],
  filter: { name: [cardName] },
  min: 0,
  max: 1,
  zone: 'monster',
  then: (_, p, z) => p.map((u) => ({ ...ss(u, z, note), as })),
});

/** 墓地から、このカードのS素材にしたモンスター一組を特殊召喚する（全部出すか、出さないか） */
const materialSetSteps = (note: string): Step[] => [
  {
    op: 'pick',
    prompt: '特殊召喚するS素材の一組（全部選ぶか、出さないなら選ばずに決定）',
    from: ['gy'],
    where: (env, u) => materialSet(env).includes(u),
    range: (env) => [0, materialSet(env).length],
    noSummonCheck: true,
    then: (env, p) => {
      const set = materialSet(env);
      if (!p.length) return [];
      if (p.length !== set.length) return [fail('S素材の一組を全て選んでください')];
      const zones = freeMz(env.state);
      if (zones.length < p.length) return [fail('モンスターゾーンの空きが足りません')];
      return p.map((u, i) => ss(u, zones[i], note));
    },
  },
];
const HALBERD_1 = 'duel:ＴＧ ハルバード・キャノン（アニメ版）①';

function materialSet(env: Env): string[] {
  const mats = env.state.cards[env.self].materials ?? [];
  return mats.length && mats.every((u) => env.loc(u)?.zone === 'gy') ? mats : [];
}

export const ANIME_SCRIPTS: Record<string, CardScript> = {
  // ＴＧ ブレード・ガンナー（アニメ版。S召喚は相手ターンでも行える）
  'anime-51447164': {
    materialCheck: TG_SCRIPTS['51447164'].materialCheck,
    effects: [
      {
        label: '① 手札を1枚墓地へ送り、相手の魔法・罠によるこのカードへの効果を無効（相手用）',
        from: ['monster'],
        opponentOnly: true,
        speed: 2,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：墓地へ送る手札',
            from: ['hand'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, 'コスト')),
          },
        ],
      },
      {
        label: '② 相手ターンに1度：このカードを除外（相手ターンのエンドフェイズに自分フィールドに戻ってくる）',
        from: ['monster'],
        key: 'ＴＧ ブレード・ガンナー（アニメ版）②',
        limit: 1,
        perCard: true,
        speed: 2,
        condition: oppTurn,
        steps: [
          {
            op: 'do',
            then: (env) => [
              { type: 'MOVE', uid: env.self, to: { zone: 'banished' }, reason: 'ＴＧ ブレード・ガンナー（アニメ版）②' },
              { type: 'RETURN_AT_OPP_END', uid: env.self },
            ],
          },
        ],
      },
      {
        label: '③ 戦闘で破壊された時：S召喚に使用した素材一組が墓地に揃っていれば、それらを特殊召喚できる',
        from: ['gy'],
        key: 'ＴＧ ブレード・ガンナー（アニメ版）③',
        limit: 1,
        perCard: true,
        trigger: true,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          if (inst.movedTurn !== env.state.turn || inst.movedReason !== '戦闘で破壊')
            return 'このターンに戦闘で破壊されていません';
          return materialSet(env).length ? null : 'S素材にしたモンスターが墓地に揃っていません';
        },
        steps: materialSetSteps('ＴＧ ブレード・ガンナー（アニメ版）の効果'),
      },
    ],
  },

  // ＴＧ ハルバード・キャノン（アニメ版）
  'anime-97836203': {
    materialCheck: TG_SCRIPTS['97836203'].materialCheck,
    effects: [
      {
        label: '① 召喚・反転召喚・特殊召喚を無効にし破壊（相手用。S素材にしたモンスターの数だけ）',
        from: ['monster'],
        key: HALBERD_1,
        perCard: true,
        opponentOnly: true,
        speed: 2,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          const used = env.state.effectUses[`${HALBERD_1}:${env.self}:${inst.entryId}`] ?? 0;
          const max = inst.materials?.length ?? 0;
          return used < max ? null : `この効果はS素材にしたモンスターの数（${max}回）まで使えます`;
        },
        steps: [],
      },
      {
        label: '② フィールドを離れた時：EXデッキの「ＴＧ ブレード・ガンナー」1体を特殊召喚できる',
        from: ['gy', 'banished'],
        key: 'ＴＧ ハルバード・キャノン（アニメ版）②',
        limit: 1,
        perCard: true,
        trigger: true,
        condition: leftFieldThisTurn,
        steps: [ssFromExtra('ＴＧ ブレード・ガンナー', 'ＴＧ ハルバード・キャノン（アニメ版）の効果')],
      },
      logOnly('③ 相手モンスターが効果でフィールドを離れる場合、その効果を無効にし攻撃力800ダウン（相手用）', [
        'monster',
      ]),
    ],
  },

  // シューティング・クェーサー・ドラゴン（アニメ版。①は素材にしたSモンスターの数だけ攻撃できる）
  'anime-35952884': {
    materialCheck: TG_SCRIPTS['35952884'].materialCheck,
    effects: [
      logOnly('② 攻撃する時、「無効にする」効果を持つカード1枚の発動をバトルフェイズ終了時まで無効（相手用）', [
        'monster',
      ]),
      {
        label:
          '⑤ フィールドを離れた時：フィールドのモンスターを全て破壊し、EXデッキの「シューティング・スター・ドラゴン」を特殊召喚できる（S召喚扱い）',
        from: ['gy', 'banished'],
        key: 'シューティング・クェーサー・ドラゴン（アニメ版）⑤',
        limit: 1,
        perCard: true,
        trigger: true,
        condition: leftFieldThisTurn,
        steps: [
          {
            op: 'do',
            then: (env) =>
              [...env.state.mz, ...env.state.emz, ...(env.state.opp ? oppMonsterSlots(env.state.opp) : [])]
                .filter((u): u is string => !!u)
                .map((u) => toGy(u, '効果で破壊')),
          },
          ssFromExtra(
            'シューティング・スター・ドラゴン',
            'シューティング・クェーサー・ドラゴン（アニメ版）の効果',
            'synchro',
          ),
        ],
      },
    ],
  },
};
