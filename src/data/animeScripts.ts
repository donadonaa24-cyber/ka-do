import { type Action, currentStats, type MonsterLocation } from '../engine/game';
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
const isSynchro = (env: Env, u: string) => env.def(u).frame === 'synchro';
const oppTurn = (env: Env) =>
  env.state.opponentTurn ? null : '相手ターンにのみ発動できます（メニューの「相手ターンへ」で相手ターンに進めます）';
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
function materialSet(env: Env): string[] {
  const mats = env.state.cards[env.self].materials ?? [];
  return mats.length && mats.every((u) => env.loc(u)?.zone === 'gy') ? mats : [];
}

export const ANIME_SCRIPTS: Record<string, CardScript> = {
  // ＴＧ ブレード・ガンナー（アニメ版）
  'anime-51447164': {
    materialCheck: TG_SCRIPTS['51447164'].materialCheck,
    effects: [
      logOnly('① このカードを対象とする相手の魔法・罠の発動を無効にし破壊（相手用）', ['monster']),
      {
        label:
          '② 相手ターン：他の自分のモンスターを除外し、このカードは攻撃対象にならない（除外したモンスターの攻撃力分ダウン）',
        from: ['monster'],
        key: 'ＴＧ ブレード・ガンナー（アニメ版）②',
        limit: 1,
        perCard: true,
        speed: 2,
        condition: oppTurn,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：除外するこのカード以外の自分フィールドのモンスター',
            from: ['monsters'],
            where: (env, u) => u !== env.self,
            min: 1,
            max: 1,
            then: (env, p) => [
              ...p.map((u) => ({ type: 'MOVE', uid: u, to: { zone: 'banished' }, reason: 'コスト' }) as Action),
              {
                type: 'STAT_MOD',
                uid: env.self,
                atk: -(currentStats(env.state, env.ctx, p[0]).atk ?? 0),
                source: 'ＴＧ ブレード・ガンナー（アニメ版）',
              },
            ],
          },
        ],
      },
      {
        label:
          '③ 戦闘で破壊された時：墓地からSモンスターのチューナーとチューナー以外のSモンスターを1体ずつ特殊召喚できる',
        from: ['gy'],
        trigger: true,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          return inst.movedTurn === env.state.turn && inst.movedReason === '戦闘で破壊'
            ? null
            : 'このターンに戦闘で破壊されていません';
        },
        steps: [
          {
            op: 'pick',
            prompt: '特殊召喚するSモンスターのチューナー（墓地。出さなくてもよい）',
            from: ['gy'],
            where: (env, u) => u !== env.self && isSynchro(env, u) && !!env.def(u).tuner,
            min: 0,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => p.map((u) => ss(u, z, 'ＴＧ ブレード・ガンナー（アニメ版）の効果')),
          },
          {
            op: 'pick',
            prompt: '特殊召喚するチューナー以外のSモンスター（墓地。出さなくてもよい）',
            from: ['gy'],
            where: (env, u) => u !== env.self && isSynchro(env, u) && !env.def(u).tuner,
            min: 0,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => p.map((u) => ss(u, z, 'ＴＧ ブレード・ガンナー（アニメ版）の効果')),
          },
        ],
      },
    ],
  },

  // ＴＧ ハルバード・キャノン（アニメ版。②は相手のモンスター効果を受けない）
  'anime-97836203': {
    materialCheck: TG_SCRIPTS['97836203'].materialCheck,
    effects: [
      logOnly(
        '① 召喚・反転召喚・特殊召喚を無効にし、そのモンスターと相手の特殊召喚されたモンスターを全て破壊（相手用）',
        ['monster'],
        'ＴＧ ハルバード・キャノン（アニメ版）①',
      ),
      {
        label: '③ フィールドから離れた時：このカードのS素材にしたモンスター一組を墓地から特殊召喚できる',
        from: ['gy', 'banished'],
        key: 'ＴＧ ハルバード・キャノン（アニメ版）③',
        limit: 1,
        perCard: true,
        trigger: true,
        condition: (env) =>
          leftFieldThisTurn(env) ?? (materialSet(env).length ? null : 'S素材にしたモンスターが墓地に揃っていません'),
        steps: materialSetSteps('ＴＧ ハルバード・キャノン（アニメ版）の効果'),
      },
    ],
  },

  // シューティング・クェーサー・ドラゴン（アニメ版。①は他のカードの効果を受けない・③はS素材の数だけ攻撃できる）
  'anime-35952884': {
    materialCheck: (env, m, method) => {
      if (method !== 'synchro') return null;
      const tuner = m.find((u) => env.def(u).tuner);
      const others = m.filter((u) => u !== tuner);
      return tuner && isSynchro(env, tuner) && others.length >= 2 && others.every((u) => isSynchro(env, u))
        ? null
        : '素材はSモンスターのチューナー＋チューナー以外のSモンスター2体以上です';
    },
    effects: [
      logOnly('② 攻撃する時、戦闘を行う相手モンスターの効果を無効（相手用）', ['monster']),
      {
        label: '④ フィールドを離れた時：EXデッキから「シューティング・スター・ドラゴン」を特殊召喚できる',
        from: ['gy', 'banished'],
        key: 'シューティング・クェーサー・ドラゴン（アニメ版）④',
        limit: 1,
        perCard: true,
        trigger: true,
        condition: leftFieldThisTurn,
        steps: [
          {
            op: 'pick',
            prompt: 'EXデッキから特殊召喚する「シューティング・スター・ドラゴン」',
            from: ['extra'],
            filter: { name: ['シューティング・スター・ドラゴン'] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'シューティング・クェーサー・ドラゴン（アニメ版）の効果')],
          },
        ],
      },
    ],
  },
};
