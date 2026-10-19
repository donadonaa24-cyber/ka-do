import {
  type Action,
  currentStats,
  getDef,
  missedTiming,
  type MonsterLocation,
  oppFieldCards,
  oppMonsterSlots,
} from '../engine/game';
import { linkedZonesOf } from '../engine/rules';
import type { CardFilter } from '../engine/filters';
import type { CardScript, EffectDef, Env, Step } from '../engine/scripts';
import type { CardDef, Location } from '../engine/types';

const TW = 'トゥーン・ワールド';

// ===== 生成データに無い性質の上書き =====

export const TOON_OVERRIDES: Record<string, Partial<CardDef>> = {
  // ブルーアイズ・トゥーン・ドラゴン
  '53183600': { cannotAttackTurnSummoned: true, attackCost: 500 },
  // トゥーン・ブラック・マジシャン
  '21296502': { cannotAttackTurnSummoned: true },
  // エビル・ボックス
  '8915275': { toonWithWorld: true },
  // トゥーン・ハーピィ・レディ
  '64116319': { cannotAttackTurnSummoned: true },
  // ファニー・ダーク・ラビット
  '45536531': { toonWithWorld: true },
  // コミックキャット
  '72921536': { toonWithWorld: true },
  // トゥーンのしおり
  '91500017': { oncePerTurnActivation: true },
  // 抹殺の指名者
  '65681983': { oncePerTurnActivation: true },
  // ティマイオスの眼光
  '22283204': { oncePerTurnActivation: true },
  // 完全なる世界 トゥーン・ワールド
  '7293697': { treatedAsToonWorld: true },
  // トゥーン・キングダム
  '43175858': { treatedAsToonWorld: true },
  // 霆王の閃光
  '6325660': { oncePerTurnActivation: true },
  // トゥーン・テラー
  '53094821': { oncePerTurnActivation: true },
  // 滅びの黒魔術師
  '59400890': { treatedAsName: 'ブラック・マジシャン' },
};

// ===== 部品 =====

/**
 * マインドフォースを発動できる時：相手フィールドの攻撃力が一番高いモンスターの攻撃宣言時／
 * フィールドのカードを破壊するモンスター効果を相手が発動した時／自分ターンに相手が手札・フィールドのモンスター効果を発動した時
 */
function mindForceTiming(env: Env): string | null {
  const s = env.state;
  const b = s.battle;
  if (b && b.byOpp && b.step === 'battle' && !missedTiming(s, b.attacker)) {
    const atk = (u: string) => currentStats(s, env.ctx, u).atk ?? 0;
    const mons = (s.opp ? oppMonsterSlots(s.opp) : []).filter((u): u is string => !!u && s.cards[u].faceUp);
    if (mons.every((u) => atk(u) <= atk(b.attacker))) return null;
  }
  const top = s.chain[s.chain.length - 1];
  if (top?.opp) {
    const d = getDef(s, env.ctx, top.uid);
    if (d.kind === 'monster' && (top.opp === 'abao' || !s.opponentTurn)) return null;
  }
  return '相手の一番攻撃力が高いモンスターの攻撃宣言時か、相手がモンスター効果を発動した時に発動できます';
}

const move = (
  uid: string,
  to: Location,
  reason?: string,
  extra: Partial<Extract<Action, { type: 'MOVE' }>> = {},
): Action => ({
  type: 'MOVE',
  uid,
  to,
  reason,
  ...extra,
});
const toHand = (uid: string, reason = '効果') => move(uid, { zone: 'hand' }, reason);
const toGy = (uid: string, reason = 'コスト') => move(uid, { zone: 'gy' }, reason);
const banish = (uid: string, reason = '効果') => move(uid, { zone: 'banished' }, reason);
const ss = (uid: string, zone: Location | null, note: string, position: 'atk' | 'def' = 'atk'): Action => ({
  type: 'SPECIAL_SUMMON',
  uid,
  to: zone as MonsterLocation,
  position,
  note,
});
const shuffle: Action = { type: 'SHUFFLE_DECK' };

/** デッキから取り出した場合はデッキをシャッフルする */
const withShuffle = (env: Env, picked: string[], actions: Action[]): Action[] =>
  picked.some((u) => env.loc(u)?.zone === 'deck') ? [...actions, shuffle] : actions;

const needToonWorld = (env: Env) => (env.toonWorld ? null : `自分フィールドに「${TW}」が必要です`);
const mainPhase = (env: Env) =>
  env.state.phase === 'M1' || env.state.phase === 'M2' ? null : 'メインフェイズにのみ発動できます';
const firstEmptyStz = (env: Env): Location => ({ zone: 'stz', index: Math.max(0, env.state.stz.indexOf(null)) });

const search = (prompt: string, filter: CardFilter, from: ('deck' | 'gy')[] = ['deck']): Step => ({
  op: 'pick',
  prompt,
  from,
  filter,
  min: 1,
  max: 1,
  then: (env, p) =>
    withShuffle(
      env,
      p,
      p.map((u) => toHand(u, from[0] === 'deck' ? 'サーチ' : 'サルベージ')),
    ),
});

const selfTo = (zone: 'gy' | 'banished', reason = 'コスト'): Step => ({
  op: 'do',
  cost: reason === 'コスト',
  then: (env) => [move(env.self, { zone }, reason)],
});

const ssSelf = (note: string): Step => ({
  op: 'place',
  prompt: 'このカードを出すゾーンを選択',
  zone: 'monster',
  then: (env, zone) => [ss(env.self, zone, note)],
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

const isEffectMonster = (d: CardDef) => d.kind === 'monster' && d.frame !== 'normal' && d.frame !== 'token';
const exactly = (n: number, m: string[]) => (m.length === n ? null : `素材はちょうど${n}体です`);

/** クロシープのリンク先にいるモンスター */
const sheepTargets = (env: Env) =>
  linkedZonesOf(env.state, env.self, env.def(env.self))
    .map((i) => env.state.mz[i])
    .filter((u): u is string => !!u && env.state.cards[u].faceUp);

/** このカードより後にこのターン特殊召喚された（効果で戻っただけのカードは含まない） */
const justSummonedAfter = (env: Env, uid: string) => {
  const inst = env.state.cards[uid];
  return (
    inst.enteredTurn === env.state.turn &&
    inst.summonedEntry === inst.entryId &&
    inst.entryId > env.state.cards[env.self].entryId
  );
};

const levelSum = (env: Env, uids: string[]) => uids.reduce((s, u) => s + (env.def(u).level ?? 0), 0);

// ===== カードごとの召喚条件・効果 =====

export const TOON_SCRIPTS: Record<string, CardScript> = {
  // 聖なる心のバリア －マインドフォース－
  '66247039': {
    effects: [
      {
        label: '発動：相手フィールドの表側表示カードを全て無効にし破壊（次のターン終了時まで直接攻撃できない）',
        from: ['spelltrap'],
        isCardActivation: true,
        condition: mindForceTiming,
        steps: [
          {
            op: 'do',
            then: (env) => {
              const targets = oppFieldCards(env.state).filter((u) => env.state.cards[u].faceUp);
              // 破壊したカードの、フィールドで発動したモンスター効果は無効になる
              const negate: Action[] = env.state.chain.flatMap((l, index) =>
                l.opp && targets.includes(l.uid) && !l.negated
                  ? [
                      {
                        type: 'CHAIN_NEGATE',
                        index,
                        mode: 'effect',
                        by: '聖なる心のバリア －マインドフォース－',
                      } as Action,
                    ]
                  : [],
              );
              return [
                ...negate,
                ...targets.map((u) => move(u, { zone: 'gy' }, '効果で破壊')),
                { type: 'NO_DIRECT_ATTACK', source: '聖なる心のバリア －マインドフォース－', nextTurn: true },
              ];
            },
          },
        ],
      },
    ],
  },

  // トゥーン・カオス・ソルジャー
  '28711704': {
    procedures: [
      {
        label: 'トゥーンモンスターをリリース（レベル合計8以上）',
        hint: '手札・フィールドのトゥーンモンスターをレベル合計8以上になるように選択',
        from: ['hand', 'monsters'],
        materialsTo: 'gy',
        summonFrom: ['hand'],
        validate: (env, m) => {
          if (m.length === 0) return 'リリースするトゥーンモンスターを選んでください';
          if (m.some((u) => !env.isToon(u))) return 'トゥーンモンスターのみリリースできます';
          if (levelSum(env, m) < 8) return `レベル合計が${levelSum(env, m)}です（8以上必要）`;
          return null;
        },
      },
    ],
    effects: [
      {
        label: '② フィールドのカード1枚を除外',
        from: ['monster'],
        key: 'トゥーン・カオス・ソルジャー②',
        limit: 1,
        perCard: true,
        condition: needToonWorld,
        steps: [
          {
            op: 'pick',
            prompt: '除外するフィールドのカードを選択（このターン、このカードは攻撃できない）',
            from: ['field'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => banish(u)),
          },
        ],
      },
    ],
  },

  // ブルーアイズ・トゥーン・ドラゴン
  '53183600': {
    procedures: [
      {
        label: '「トゥーン・ワールド」がある状態でモンスター2体をリリース',
        hint: '自分フィールドのモンスターを2体選択',
        from: ['monsters'],
        materialsTo: 'gy',
        summonFrom: ['hand'],
        validate: (env, m) => needToonWorld(env) ?? (m.length === 2 ? null : 'モンスターを2体リリースしてください'),
      },
    ],
  },

  // トゥーン・ブラック・マジシャン
  '21296502': {
    effects: [
      {
        label: '③ 手札の「トゥーン」を捨て、デッキからトゥーンモンスターを特殊召喚',
        from: ['monster'],
        key: 'トゥーン・ブラック・マジシャン③',
        limit: 1,
        perCard: true,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：手札から捨てる「トゥーン」カードを選択',
            from: ['hand'],
            filter: { archetype: 'トゥーン' },
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u)),
          },
          {
            op: 'pick',
            prompt: 'デッキから特殊召喚するトゥーンモンスター（「トゥーン・ブラック・マジシャン」以外）',
            from: ['deck'],
            filter: { toonMonster: true, excludeName: ['トゥーン・ブラック・マジシャン'] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, '召喚条件を無視')]),
          },
        ],
      },
      {
        label: '③ 手札の「トゥーン」を捨て、デッキから「トゥーン」魔法・罠を手札へ',
        from: ['monster'],
        key: 'トゥーン・ブラック・マジシャン③',
        limit: 1,
        perCard: true,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：手札から捨てる「トゥーン」カードを選択',
            from: ['hand'],
            filter: { archetype: 'トゥーン' },
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u)),
          },
          search('デッキから手札に加える「トゥーン」魔法・罠', { archetype: 'トゥーン', kind: ['spell', 'trap'] }),
        ],
      },
    ],
  },

  // エビル・ボックス
  '8915275': {
    effects: [
      {
        label: '① 手札から特殊召喚＋デッキの「トゥーン」罠を手札かセット',
        from: ['hand'],
        key: 'エビル・ボックス①',
        limit: 1,
        condition: needToonWorld,
        steps: [
          ssSelf('自身の効果'),
          {
            op: 'pick',
            prompt: 'その後：デッキの「トゥーン」罠を選択（任意）',
            from: ['deck'],
            filter: { archetype: 'トゥーン', kind: ['trap'] },
            min: 0,
            max: 1,
            modes: ['手札に加える', 'セットする'],
            zone: 'stz',
            zoneIf: (_, __, mode) => mode === 1,
            then: (env, p, z, mode) =>
              withShuffle(
                env,
                p,
                p.map((u) =>
                  mode === 0 ? toHand(u, 'サーチ') : move(u, z ?? firstEmptyStz(env), 'セット', { faceUp: false }),
                ),
              ),
          },
        ],
      },
      {
        label: '③ 墓地のカード1枚をデッキの一番下へ',
        speed: 2,
        from: ['monster'],
        key: 'エビル・ボックス③',
        limit: 1,
        perCard: true,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキの一番下に戻す墓地のカード',
            from: ['gy'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => move(u, { zone: 'deck' }, '効果', { toBottom: true })),
          },
        ],
      },
    ],
  },

  // トゥーン・ブラック・マジシャン・ガール
  '90960358': {
    procedures: [
      {
        label: '「トゥーン・ワールド」がある状態でモンスター1体をリリース',
        hint: '自分フィールドのモンスターを1体選択',
        from: ['monsters'],
        materialsTo: 'gy',
        summonFrom: ['hand'],
        validate: (env, m) => needToonWorld(env) ?? (m.length === 1 ? null : 'モンスターを1体リリースしてください'),
      },
    ],
  },

  // 闇の眼を持つ幻想師・ノー・フェイス
  '34314989': {
    effects: [
      {
        label: '① 捨てて「心を見通す眼」を手札・デッキから表側で置く',
        from: ['hand'],
        key: 'ノー・フェイス①心を見通す眼',
        limit: 1,
        steps: [
          selfTo('gy'),
          {
            op: 'pick',
            prompt: '表側で置く「心を見通す眼」（手札・デッキ）',
            from: ['hand', 'deck'],
            filter: { name: ['心を見通す眼'] },
            min: 1,
            max: 1,
            zone: 'stz',
            then: (env, p, z) =>
              withShuffle(
                env,
                p,
                p.map((u) => move(u, z ?? firstEmptyStz(env), '表側で置く', { faceUp: true })),
              ),
          },
        ],
      },
      {
        label: '① 捨てて墓地の「トゥーン・ワールド」記載モンスターを手札へ（その後特殊召喚可）',
        from: ['hand'],
        key: 'ノー・フェイス①サルベージ',
        limit: 1,
        steps: [
          selfTo('gy'),
          {
            op: 'pick',
            prompt: '墓地から手札に加える「トゥーン・ワールド」記載モンスター（このカード以外）',
            from: ['gy'],
            filter: { kind: ['monster'], mentions: TW },
            where: (env, u) => u !== env.self,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toHand(u, 'サルベージ')),
          },
          {
            op: 'pick',
            prompt: 'その後：そのモンスターを召喚条件を無視して特殊召喚できる（任意）',
            from: ['hand'],
            where: (env, u) => env.state.hand[env.state.hand.length - 1] === u,
            min: 0,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => p.map((u) => ss(u, z, '召喚条件を無視')),
          },
        ],
      },
    ],
  },

  // トゥーン・ハーピィ・レディ
  '64116319': {
    effects: [
      {
        label: '① 手札から特殊召喚',
        from: ['hand'],
        key: 'トゥーン・ハーピィ・レディ①',
        limit: 1,
        condition: needToonWorld,
        steps: [ssSelf('自身の効果')],
      },
    ],
  },

  // ファニー・ダーク・ラビット
  '45536531': {
    effects: [
      {
        label: '① 召喚・特殊召喚時：「トゥーン・ワールド」記載モンスターの追加召喚',
        onSummon: true,
        // 「召喚・特殊召喚した時に適用する」発動しない効果
        applied: true,
        from: ['monster'],
        steps: [
          {
            op: 'do',
            then: (env) =>
              env.state.summonGrants.some((g) => g.source === 'ファニー・ダーク・ラビット')
                ? []
                : [
                    {
                      type: 'GRANT_SUMMON',
                      grant: {
                        source: 'ファニー・ダーク・ラビット',
                        extraSummon: true,
                        noTribute: false,
                        filter: { mentions: TW },
                        thisTurnOnly: true,
                      },
                    },
                  ],
          },
        ],
      },
      {
        label: '③ デッキの「トゥーン」フィールド・永続魔法を手札か表側で置く',
        from: ['monster'],
        key: 'ファニー・ダーク・ラビット③',
        limit: 1,
        perCard: true,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキの「トゥーン」フィールド魔法・永続魔法',
            from: ['deck'],
            filter: { archetype: 'トゥーン', spellType: ['field', 'continuous'] },
            min: 1,
            max: 1,
            modes: ['手札に加える', '表側で置く'],
            zone: 'stz',
            // フィールド魔法はフィールドゾーンに置くので、永続魔法を置く時だけゾーンを選ぶ
            zoneIf: (env, p, mode) => mode === 1 && env.def(p[0]).spellType !== 'field',
            then: (env, p, z, mode) => {
              const u = p[0];
              if (mode === 0) return withShuffle(env, p, [toHand(u, 'サーチ')]);
              if (env.def(u).spellType === 'field') {
                const old = env.state.fz ? [toGy(env.state.fz, '張り替え')] : [];
                return withShuffle(env, p, [...old, move(u, { zone: 'fz' }, '表側で置く', { faceUp: true })]);
              }
              return withShuffle(env, p, [move(u, z ?? firstEmptyStz(env), '表側で置く', { faceUp: true })]);
            },
          },
        ],
      },
    ],
  },

  // 幽鬼うさぎ
  '59438930': {
    effects: [
      logOnly('① 墓地へ送り、効果を発動したカードを破壊（相手用）', ['hand', 'monster'], '幽鬼うさぎ', [selfTo('gy')]),
    ],
  },
  // 灰流うらら
  '14558127': { effects: [logOnly('① 捨てて効果を無効（相手用）', ['hand'], '灰流うらら', [selfTo('gy')])] },
  // 増殖するＧ
  '23434538': { effects: [logOnly('① 墓地へ送って発動（相手用）', ['hand'], '増殖するＧ', [selfTo('gy')])] },
  // ドロール＆ロックバード
  '94145021': { effects: [logOnly('① 墓地へ送って発動（相手用）', ['hand'], undefined, [selfTo('gy')])] },

  // カートゥーン・シェード
  '55363218': {
    procedures: [
      {
        label: '通常召喚できないモンスターが表側で存在する',
        hint: '',
        from: [],
        materialsTo: 'gy',
        oncePerTurn: true,
        summonFrom: ['hand'],
        validate: (env) =>
          [...env.state.mz, ...env.state.emz].some(
            (u) => u && env.state.cards[u].faceUp && env.def(u).cannotNormalSummon,
          )
            ? null
            : '通常召喚できないモンスターがフィールドに表側表示で必要です',
      },
    ],
    effects: [
      {
        label: '① 特殊召喚時：攻撃力か守備力2000の通常召喚できないモンスターをサーチ',
        onSummon: true,
        from: ['monster'],
        steps: [
          search('デッキから手札に加える、攻撃力か守備力が2000の通常召喚できないモンスター', {
            kind: ['monster'],
            cannotNormalSummon: true,
            atkOrDef: 2000,
          }),
        ],
      },
      {
        label: '② リリースされた時：フィールドのカードを手札に戻す',
        from: ['gy'],
        steps: [
          {
            op: 'pick',
            prompt: '手札に戻すフィールドのカード（攻守2000のモンスターがいれば2枚まで）',
            from: ['field'],
            min: 1,
            max: 2,
            then: (_, p) => p.map((u) => toHand(u, 'バウンス')),
          },
        ],
      },
    ],
  },

  // コミックキャット
  '72921536': {
    effects: [
      {
        label: '② モンスター1体をリリースし、「トゥーン・ワールド」記載モンスターを手札・デッキから特殊召喚',
        speed: 2,
        from: ['monster'],
        key: 'コミックキャット②',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：リリースするモンスター（「トゥーン・ワールド」があれば相手のモンスターも選べる）',
            from: ['monsters', 'oppMonsters'],
            where: (env, u) => !env.state.cards[u].opp || env.toonWorld,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, 'リリース')),
          },
          {
            op: 'pick',
            prompt: '召喚条件を無視して特殊召喚する「トゥーン・ワールド」記載モンスター（手札・デッキ）',
            from: ['hand', 'deck'],
            filter: { kind: ['monster'], mentions: TW },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, '召喚条件を無視')]),
          },
        ],
      },
    ],
  },

  // トゥーンのしおり
  '91500017': {
    effects: [
      {
        label: '発動：「トゥーン・ワールド」か記載カードをサーチ',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          search('デッキから手札に加える「トゥーン・ワールド」かその記載カード（「トゥーンのしおり」以外）', {
            mentions: TW,
            excludeName: ['トゥーンのしおり'],
          }),
        ],
      },
      logOnly('② 墓地から除外して「トゥーン・ワールド」の破壊を身代わり', ['gy'], undefined, [selfTo('banished')]),
    ],
  },

  // トゥーンのもくじ
  '89997728': {
    effects: [
      {
        label: '発動：「トゥーン」カードをサーチ',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [search('デッキから手札に加える「トゥーン」カード', { archetype: 'トゥーン' })],
      },
    ],
  },

  // トゥーン・ロールバック
  '70560957': {
    effects: [
      {
        label: '発動：トゥーンモンスター1体を2回攻撃可能に',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'pick',
            prompt: '対象にする自分フィールドのトゥーンモンスター',
            from: ['monsters'],
            filter: { toonMonster: true },
            min: 1,
            max: 1,
            then: (_, p) => [{ type: 'DOUBLE_ATTACK', uid: p[0] }],
          },
        ],
      },
    ],
  },

  // 抹殺の指名者
  '65681983': {
    effects: [
      {
        label: '発動：宣言したカードをデッキから除外',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから除外するカード',
            from: ['deck'],
            min: 1,
            max: 1,
            then: (env, p) =>
              withShuffle(
                env,
                p,
                p.map((u) => banish(u, '抹殺の指名者')),
              ),
          },
        ],
      },
    ],
  },

  // ティマイオスの眼光
  '22283204': {
    effects: [
      {
        label: '発動：「ブラック・マジシャン」をデッキに戻して融合召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'pick',
            prompt: '対象：自分のフィールド・墓地の「ブラック・マジシャン」か「ブラック・マジシャン・ガール」',
            from: ['monsters', 'gy'],
            filter: { name: ['ブラック・マジシャン', 'ブラック・マジシャン・ガール'] },
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => move(u, { zone: 'deck' }, '融合素材としてデッキへ')),
          },
          {
            op: 'pick',
            prompt: '融合召喚する融合モンスター（「ブラック・マジシャン」が素材として記されたもの）',
            from: ['extra'],
            where: (env, u) =>
              env.def(u).frame === 'fusion' &&
              /「ブラック・マジシャン(・ガール)?」/.test(env.def(u).materialText ?? ''),
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [
              ss(p[0], z, '「ティマイオスの眼」の効果扱いで融合召喚。次のターンのエンドフェイズに除外'),
            ],
          },
        ],
      },
    ],
  },

  // 完全なる世界 トゥーン・ワールド
  '7293697': {
    // ③ 他のカードの効果処理の間だけトゥーンモンスターを除外（戻ったモンスターは「1ターンに1度」をもう一度使える）
    tempBanish: { label: '完全なる世界 トゥーン・ワールド③', key: '完全なる世界③', filter: { toonMonster: true } },
    effects: [
      {
        label: '発動',
        from: ['hand', 'field-zone'],
        isCardActivation: true,
        steps: [],
      },
      {
        label: '② 「トゥーン」か「トゥーン・ワールド」記載カードをサーチ',
        from: ['field-zone'],
        key: '完全なる世界 トゥーン・ワールド②',
        limit: 1,
        perCard: true,
        nameLimit: 3,
        condition: mainPhase,
        steps: [
          search('デッキから手札に加える「トゥーン」カードか「トゥーン・ワールド」記載カード', {
            any: [{ archetype: 'トゥーン' }, { mentions: TW }],
          }),
        ],
      },
    ],
  },

  // トゥーン・キングダム
  '43175858': {
    effects: [
      {
        label: '発動：デッキの上から3枚を裏側で除外',
        from: ['hand', 'field-zone'],
        isCardActivation: true,
        steps: [
          {
            op: 'do',
            then: (env) =>
              env.state.deck.slice(0, 3).map((u) => move(u, { zone: 'banished' }, '裏側で除外', { faceUp: false })),
          },
        ],
      },
    ],
  },

  // 心を見通す眼
  '34298391': {
    effects: [logOnly('② カード名を宣言して無効（相手用）', ['spelltrap'], '心を見通す眼②')],
  },

  // ブルーアイズ・トゥーン・アルティメットドラゴン
  '71808988': {
    materialCheck: () => 'このカードは手札・フィールド・墓地の素材をデッキに戻す方法でのみ特殊召喚できます',

    procedures: [
      {
        label: '「ブルーアイズ・トゥーン・ドラゴン」＋トゥーンモンスター×2をデッキに戻す',
        hint: '手札・フィールド・墓地から「ブルーアイズ・トゥーン・ドラゴン」とトゥーンモンスター2体を選択',
        from: ['hand', 'monsters', 'gy'],
        materialsTo: 'deck',
        summonFrom: ['extra'],
        materialFilter: (env, u) => env.isToon(u),
        validate: (env, m) => {
          if (m.length !== 3) return '素材を3体選んでください';
          if (!m.some((u) => env.def(u).name === 'ブルーアイズ・トゥーン・ドラゴン'))
            return '「ブルーアイズ・トゥーン・ドラゴン」が必要です';
          if (m.some((u) => !env.isToon(u))) return 'トゥーンモンスター以外が含まれています';
          return null;
        },
      },
    ],
    effects: [
      {
        label: '② 墓地の「トゥーン」か記載カードを手札へ',
        from: ['monster'],
        key: 'ブルーアイズ・トゥーン・アルティメットドラゴン②',
        limit: 1,
        perCard: true,
        condition: mainPhase,
        steps: [
          search(
            '墓地から手札に加える「トゥーン」カードか「トゥーン・ワールド」記載カード',
            { any: [{ archetype: 'トゥーン' }, { mentions: TW }] },
            ['gy'],
          ),
        ],
      },
      {
        label: '③ 自分のトゥーンが攻撃されるダメージ計算時：そのモンスターをダメージステップ終了時まで除外',
        from: ['monster'],
        trigger: true,
        damageStep: true,
        condition: (env) => {
          const b = env.state.battle;
          if (!b || !b.byOpp || b.step !== 'calc')
            return '相手のモンスターが自分のトゥーンに攻撃するダメージ計算時に発動できます';
          if (!b.target || !env.isToon(b.target)) return '攻撃されているのが自分のトゥーンモンスターではありません';
          return env.state.effectUses[`BTUD③:${b.attacker}:${env.state.turn}`] ? 'この戦闘では使用済みです' : null;
        },
        steps: [
          {
            op: 'do',
            then: (env) => {
              const b = env.state.battle!;
              return [
                { type: 'ACTIVATE_EFFECT', uid: env.self, silent: true, key: `BTUD③:${b.attacker}:${env.state.turn}` },
                { type: 'BANISH_UNTIL_DAMAGE_END', uid: b.target! },
              ];
            },
          },
        ],
      },
    ],
  },

  // 超魔導竜騎士－ドラグーン・オブ・レッドアイズ
  '37818794': {
    materialCheck: (env, m) => {
      if (m.length !== 2) return '融合素材は2体です';
      const bm = m.find((u) => env.matches(u, { name: ['ブラック・マジシャン'] }));
      const other = m.find((u) => u !== bm);
      if (!bm || !other) return '「ブラック・マジシャン」が必要です';
      const d = env.def(other);
      return d.name === '真紅眼の黒竜' || (d.race === 'ドラゴン族' && isEffectMonster(d))
        ? null
        : '「真紅眼の黒竜」かドラゴン族の効果モンスターが必要です';
    },

    effects: [
      logOnly('② 相手モンスターを破壊（相手用）', ['monster']),
      {
        label: '③ 手札1枚を捨てて発動を無効（相手用）',
        speed: 2,
        from: ['monster'],
        key: 'ドラグーン③',
        limit: 1,
        perCard: true,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：捨てる手札',
            from: ['hand'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u)),
          },
        ],
      },
    ],
  },

  // 滅びの黒魔術師
  '59400890': {
    materialCheck: (env, m) => {
      if (m.length !== 2) return '融合素材は2体です';
      const bm = m.find((u) => env.matches(u, { name: ['ブラック・マジシャン'] }));
      const other = m.find((u) => u !== bm);
      if (!bm || !other) return '「ブラック・マジシャン」が必要です';
      return ['光', '闇'].includes(env.def(other).attribute ?? '') ? null : '光・闇属性モンスターが必要です';
    },
    procedures: [
      {
        label: '魔法の効果が発動したターン、Lv6以上の闇属性魔法使い族を除外',
        hint: '自分フィールドのレベル6以上の魔法使い族・闇属性モンスターを1体選択',
        from: ['monsters'],
        materialsTo: 'banished',
        oncePerTurn: true,
        summonFrom: ['extra'],
        validate: (env, m) => {
          if (!env.state.spellActivatedThisTurn) return 'このターンに魔法カードの効果が発動している必要があります';
          if (m.length !== 1) return 'モンスターを1体選んでください';
          const d = env.def(m[0]);
          if (!((d.level ?? 0) >= 6 && d.race === '魔法使い族' && d.attribute === '闇')) {
            return 'レベル6以上の魔法使い族・闇属性モンスターを選んでください';
          }
          return null;
        },
      },
    ],
    effects: [
      {
        label: '② 特殊召喚時：「ブラック・マジシャン」か記載カードをサーチ',
        onSummon: true,
        from: ['monster'],
        key: '滅びの黒魔術師②',
        steps: [
          search('デッキから手札に加える「ブラック・マジシャン」かその記載カード', {
            mentions: 'ブラック・マジシャン',
          }),
        ],
      },
    ],
  },

  // 厄災の星ティ・フォン
  '93039339': {
    effects: [
      {
        label: '② X素材を1つ取り除き、フィールドのモンスターを手札に戻す',
        from: ['monster'],
        key: '厄災の星ティ・フォン②',
        limit: 1,
        perCard: true,
        condition: (env) => (env.state.cards[env.self].overlay.length ? null : 'X素材がありません'),
        steps: [
          {
            op: 'do',
            cost: true,
            then: (env) => [{ type: 'DETACH', target: env.self, uid: env.state.cards[env.self].overlay[0] }],
          },
          {
            op: 'pick',
            prompt: '手札に戻すフィールドのモンスター',
            from: ['monsters'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toHand(u, 'バウンス')),
          },
        ],
      },
    ],
  },

  // 光なき影 ア＝バオ・ア・クゥー
  '4731783': {
    materialCheck: (env, m) =>
      m.length < 2
        ? '素材は2体以上です'
        : m.some((u) => env.def(u).race === '悪魔族')
          ? null
          : '悪魔族モンスターを含める必要があります',

    effects: [
      {
        label: '① 手札1枚を捨て、フィールドのカード1枚を破壊',
        speed: 2,
        from: ['monster'],
        key: 'ア＝バオ・ア・クゥー①',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：捨てる手札',
            from: ['hand'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u)),
          },
          {
            op: 'pick',
            prompt: '破壊するフィールドのカード',
            from: ['field'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '破壊')),
          },
        ],
      },
      {
        label: '① 手札1枚を捨て、自身を除外して墓地の光・闇を特殊召喚',
        speed: 2,
        from: ['monster'],
        key: 'ア＝バオ・ア・クゥー①',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：捨てる手札',
            from: ['hand'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u)),
          },
          selfTo('banished', 'エンドフェイズまで除外'),
          {
            op: 'pick',
            prompt: '墓地から特殊召喚する光・闇属性モンスター',
            from: ['gy'],
            filter: { kind: ['monster'], attribute: ['光', '闇'] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'ア＝バオ・ア・クゥーの効果')],
          },
        ],
      },
      {
        label: '② スタンバイフェイズ：墓地の種族の数だけドローし、同じ数をデッキの下へ',
        from: ['monster'],
        key: 'ア＝バオ・ア・クゥー②',
        limit: 1,
        steps: [
          {
            op: 'do',
            then: (env) => {
              const n = new Set(env.state.gy.filter((u) => env.def(u).kind === 'monster').map((u) => env.def(u).race))
                .size;
              return n ? [{ type: 'DRAW', count: n }] : [];
            },
          },
          {
            op: 'pick',
            prompt: 'デッキの下に戻す手札（ドローした数）',
            from: ['hand'],
            count: (env) =>
              new Set(env.state.gy.filter((u) => env.def(u).kind === 'monster').map((u) => env.def(u).race)).size,
            then: (_, p) => p.map((u) => move(u, { zone: 'deck' }, '効果', { toBottom: true })),
          },
        ],
      },
    ],
  },

  // 神聖魔皇后セレーネ
  '45819647': {
    materialCheck: (env, m) =>
      m.length < 2
        ? '素材は2体以上です'
        : m.some((u) => env.def(u).race === '魔法使い族')
          ? null
          : '魔法使い族モンスターを含める必要があります',

    effects: [
      {
        label: '① L召喚時：フィールド・墓地の魔法の数だけ魔力カウンターを置く',
        onSummon: true,
        from: ['monster'],
        steps: [
          {
            op: 'do',
            then: (env) => {
              const spells = [...env.state.stz, env.state.fz, ...env.state.gy].filter(
                (u): u is string => !!u && env.def(u).kind === 'spell',
              ).length;
              return [{ type: 'SET_COUNTERS', uid: env.self, value: spells }];
            },
          },
        ],
      },
      {
        label: '③ 魔力カウンター3つで手札・墓地の魔法使い族を守備表示で特殊召喚',
        speed: 2,
        from: ['monster'],
        key: '神聖魔皇后セレーネ③',
        limit: 1,
        perCard: true,
        condition: (env) => (env.state.cards[env.self].counters >= 3 ? null : '魔力カウンターが3つ必要です'),
        steps: [
          {
            op: 'do',
            cost: true,
            then: (env) => [{ type: 'SET_COUNTERS', uid: env.self, value: env.state.cards[env.self].counters - 3 }],
          },
          {
            op: 'pick',
            prompt: '特殊召喚する魔法使い族（手札・墓地）→ このカードのリンク先を選択',
            from: ['hand', 'gy'],
            filter: { kind: ['monster'], race: ['魔法使い族'] },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'セレーネの効果', 'def')],
          },
        ],
      },
    ],
  },

  // 神書の使いラハムゥ
  '53904087': {
    materialCheck: (env, m) =>
      exactly(2, m) ?? (m.every((u) => isEffectMonster(env.def(u))) ? null : '効果モンスター2体が必要です'),

    effects: [
      {
        label: '① レベル5以上をリリースなしで召喚できるようにする',
        from: ['monster'],
        key: '神書の使いラハムゥ①',
        limit: 1,
        steps: [
          {
            op: 'do',
            then: () => [
              {
                type: 'GRANT_SUMMON',
                grant: {
                  source: '神書の使いラハムゥ',
                  extraSummon: false,
                  noTribute: true,
                  filter: { minLevel: 5 },
                  thisTurnOnly: false,
                },
              },
            ],
          },
        ],
      },
      {
        label: '② レベル5以上の闇属性モンスター1体の召喚を行う',
        speed: 2,
        from: ['monster'],
        key: '神書の使いラハムゥ②',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'do',
            then: () => [
              {
                type: 'GRANT_SUMMON',
                grant: {
                  source: '神書の使いラハムゥ②',
                  extraSummon: true,
                  noTribute: false,
                  filter: { attribute: ['闇'], minLevel: 5 },
                  thisTurnOnly: true,
                },
              },
            ],
          },
        ],
      },
      {
        label: '③ エンドフェイズ：手札のモンスターをデッキの下に戻し、同じ数ドロー',
        from: ['monster'],
        key: '神書の使いラハムゥ③',
        limit: 1,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキの下に戻す手札のモンスター（好きな数）',
            from: ['hand'],
            filter: { kind: ['monster'] },
            min: 0,
            max: 60,
            then: (_, p) =>
              p.length
                ? [
                    ...p.map((u) => move(u, { zone: 'deck' }, '効果', { toBottom: true })),
                    { type: 'DRAW', count: p.length },
                  ]
                : [],
          },
        ],
      },
    ],
  },

  // Ｉ：Ｐマスカレーナ
  '65741786': {
    materialCheck: (env, m) =>
      exactly(2, m) ?? (m.some((u) => env.def(u).frame === 'link') ? 'リンクモンスターは素材にできません' : null),
    effects: [logOnly('① 相手メインフェイズにL召喚（相手用）', ['monster'], 'Ｉ：Ｐマスカレーナ①')],
  },

  // Ｓ：Ｐリトルナイト
  '29301450': {
    materialCheck: (env, m) =>
      exactly(2, m) ?? (m.every((u) => isEffectMonster(env.def(u))) ? null : '効果モンスター2体が必要です'),

    effects: [
      {
        label: '① 融合・S・X・Lを素材にL召喚時：フィールド・墓地のカード1枚を除外',
        onSummon: true,
        from: ['monster'],
        key: 'Ｓ：Ｐリトルナイト①',
        limit: 1,
        steps: [
          {
            op: 'pick',
            prompt: '除外するフィールド・墓地のカード（このターン自分のモンスターは直接攻撃できない）',
            from: ['field', 'gy'],
            min: 1,
            max: 1,
            then: (_, p) => [...p.map((u) => banish(u)), { type: 'NO_DIRECT_ATTACK', source: 'Ｓ：Ｐリトルナイト' }],
          },
        ],
      },
      {
        label: '② 表側モンスター2体をエンドフェイズまで除外',
        speed: 2,
        from: ['monster'],
        key: 'Ｓ：Ｐリトルナイト②',
        limit: 1,
        steps: [
          {
            op: 'pick',
            prompt: 'エンドフェイズまで除外する表側表示モンスター2体（自分のモンスターを含む）',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 2,
            then: (_, p) => p.map((u) => banish(u, 'エンドフェイズまで')),
          },
        ],
      },
    ],
  },

  // クロシープ
  '50277355': {
    materialCheck: (env, m) =>
      exactly(2, m) ?? (env.def(m[0]).name === env.def(m[1]).name ? 'カード名が異なるモンスター2体が必要です' : null),

    effects: [
      {
        label: '① リンク先に特殊召喚された時：リンク先のモンスターの種類に応じて適用',
        from: ['monster'],
        key: 'クロシープ',
        limit: 1,
        condition: (env) =>
          sheepTargets(env).some((u) => justSummonedAfter(env, u))
            ? null
            : 'リンク先にこのカードより後に特殊召喚されたモンスターがいません',
        steps: [
          {
            op: 'do',
            then: (env) => {
              const frames = new Set(sheepTargets(env).map((u) => env.def(u).frame));
              const out: Action[] = [];
              if (frames.has('ritual')) out.push({ type: 'DRAW', count: 2 });
              return out;
            },
          },
          {
            op: 'pick',
            prompt: '儀式：捨てる手札2枚',
            from: ['hand'],
            count: (env) => (sheepTargets(env).some((u) => env.def(u).frame === 'ritual') ? 2 : 0),
            then: (_, p) => p.map((u) => toGy(u, '効果')),
          },
          {
            op: 'pick',
            prompt: '融合：墓地から特殊召喚するレベル4以下のモンスター',
            from: ['gy'],
            filter: { kind: ['monster'], maxLevel: 4 },
            count: (env) => (sheepTargets(env).some((u) => env.def(u).frame === 'fusion') ? 1 : 0),
            zone: 'monster',
            then: (_, p, z) => p.map((u) => ss(u, z, 'クロシープの効果')),
          },
        ],
      },
    ],
  },

  // サクリファイス・アニマ
  '94259633': {
    materialCheck: (env, m) => {
      if (m.length !== 1) return '素材は1体です';
      const d = env.def(m[0]);
      return d.frame !== 'token' && d.level === 1 ? null : 'トークン以外のレベル1モンスターが必要です';
    },

    effects: [
      {
        label: '① リンク先の表側モンスターを装備する',
        from: ['monster'],
        key: 'サクリファイス・アニマ①',
        limit: 1,
        steps: [
          {
            op: 'pick',
            prompt: '装備するリンク先の表側表示モンスター',
            from: ['monsters'],
            // このカードのリンク先（メインモンスターゾーン）の表側表示モンスター
            where: (env, u) =>
              u !== env.self &&
              env.state.cards[u].faceUp &&
              linkedZonesOf(env.state, env.self, env.def(env.self)).includes(env.state.mz.indexOf(u)),
            min: 1,
            max: 1,
            zone: 'stz',
            // ②：装備したモンスターの攻撃力分アップ
            then: (env, p, z) =>
              p.flatMap((u) => [
                move(u, z ?? firstEmptyStz(env), '装備カード扱い', { faceUp: true, equipTo: env.self }),
                { type: 'STAT_MOD', uid: u, equip: true, atk: env.def(u).atk ?? 0 } as Action,
              ]),
          },
        ],
      },
    ],
  },
};
