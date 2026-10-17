import type { Action, MonsterLocation } from '../engine/game';
import type { CardScript, EffectDef, Env, Step } from '../engine/scripts';
import type { CardDef, Location } from '../engine/types';

// トゥーンデッキ以外のカードの召喚条件・効果。相手がいる時だけ意味がある効果は、コストを払って記録するだけにする。

const TW = 'トゥーン・ワールド';

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

const selfToGy: Step = { op: 'do', cost: true, then: (env) => [move(env.self, { zone: 'gy' }, 'コスト')] };

const opponentOnly = (label: string, from: EffectDef['from'], key?: string, steps: Step[] = []): EffectDef => ({
  label,
  from,
  key,
  limit: key ? 1 : undefined,
  opponentOnly: true,
  speed: 2,
  steps,
});

const isEffectMonster = (d: CardDef) => d.kind === 'monster' && d.frame !== 'normal' && d.frame !== 'token';
const isExtraFrame = (d: CardDef) => ['fusion', 'synchro', 'xyz', 'link'].includes(d.frame ?? '');
const ownFieldEmpty = (env: Env) =>
  [...env.state.mz, ...env.state.emz, ...env.state.stz, env.state.fz].some(Boolean)
    ? '自分フィールドにカードがあると発動できません'
    : null;

/** 精霊コロゾの素材：融合・S・X・Lモンスター＋魔法使い族モンスター */
const corozoMaterials = (env: Env, m: string[]) => {
  if (m.length !== 2) return '素材は2体です';
  const [a, b] = m.map(env.def);
  const ok = (x: CardDef, y: CardDef) => isExtraFrame(x) && y.race === '魔法使い族';
  return ok(a, b) || ok(b, a) ? null : '融合・S・X・Lモンスターと魔法使い族モンスターが必要です';
};

export const OTHER_SCRIPTS: Record<string, CardScript> = {
  // エフェクト・ヴェーラー
  '97268402': {
    effects: [
      opponentOnly('① 相手メインフェイズに墓地へ送り、相手モンスターの効果を無効（相手用）', ['hand'], undefined, [
        selfToGy,
      ]),
    ],
  },

  // 屋敷わらし
  '73642296': { effects: [opponentOnly('① 捨てて墓地関連の効果を無効（相手用）', ['hand'], '屋敷わらし', [selfToGy])] },

  // マルチャミー・フワロス
  '42141493': {
    effects: [
      {
        ...opponentOnly('① 捨てて発動（相手の特殊召喚でドロー・相手用）', ['hand'], 'マルチャミー・フワロス', [
          selfToGy,
        ]),
        condition: ownFieldEmpty,
      },
    ],
  },

  // 精霊コロゾ
  '66532962': {
    materialCheck: (env, m) => corozoMaterials(env, m),
    procedures: [
      {
        label: '融合・S・X・Lモンスターと魔法使い族を墓地へ送る',
        hint: '自分フィールドの融合・S・X・Lモンスター1体と魔法使い族モンスター1体を選択',
        from: ['monsters'],
        materialsTo: 'gy',
        summonFrom: ['extra'],
        validate: (env, m) => corozoMaterials(env, m),
      },
    ],
    effects: [opponentOnly('① 攻撃宣言時、その攻撃を無効にして攻撃力アップ（相手用）', ['monster'])],
  },

  // ヴァレルロード・Ｓ・ドラゴン
  '27548199': {
    effects: [
      {
        label: '① S召喚時：墓地のLモンスターを装備し、リンクマーカーの数だけヴァレルカウンターを置く',
        from: ['monster'],
        onSummon: true,
        steps: [
          {
            op: 'pick',
            prompt: '装備する自分の墓地のリンクモンスター',
            from: ['gy'],
            filter: { kind: ['monster'], frame: ['link'] },
            min: 1,
            max: 1,
            then: (env, p) => {
              const index = env.state.stz.indexOf(null);
              if (index < 0) return [];
              const counters = env.state.cards[env.self].counters + (env.def(p[0]).link ?? 0);
              return [
                move(p[0], { zone: 'stz', index }, '装備魔法扱い', { faceUp: true }),
                { type: 'SET_COUNTERS', uid: env.self, value: counters },
              ];
            },
          },
        ],
      },
      {
        ...opponentOnly(
          '③ ヴァレルカウンターを1つ取り除いて相手の発動を無効（相手用）',
          ['monster'],
          'ヴァレルロード・Ｓ・ドラゴン③',
          [
            {
              op: 'do',
              cost: true,
              then: (env) => [{ type: 'SET_COUNTERS', uid: env.self, value: env.state.cards[env.self].counters - 1 }],
            },
          ],
        ),
        condition: (env) => (env.state.cards[env.self].counters > 0 ? null : 'ヴァレルカウンターがありません'),
      },
    ],
  },

  // フルール・ド・バロネス
  '84815190': {
    effects: [
      {
        label: '① フィールドのカード1枚を破壊',
        from: ['monster'],
        key: 'フルール・ド・バロネス①',
        limit: 1,
        perCard: true,
        steps: [
          {
            op: 'pick',
            prompt: '破壊するフィールドのカード',
            from: ['field'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => move(u, { zone: 'gy' }, '破壊')),
          },
        ],
      },
      opponentOnly('② 効果の発動を無効にし破壊（相手用）', ['monster'], 'フルール・ド・バロネス②'),
      {
        label: '③ スタンバイフェイズ：EXデッキに戻り、墓地のレベル9以下を特殊召喚',
        from: ['monster'],
        condition: (env) => (env.state.phase === 'SP' ? null : 'スタンバイフェイズにのみ発動できます'),
        steps: [
          { op: 'do', then: (env) => [move(env.self, { zone: 'extra' }, 'EXデッキへ戻る')] },
          {
            op: 'pick',
            prompt: '特殊召喚する自分の墓地のレベル9以下のモンスター',
            from: ['gy'],
            filter: { kind: ['monster'], maxLevel: 9 },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [
              { type: 'SPECIAL_SUMMON', uid: p[0], to: z as MonsterLocation, note: 'フルール・ド・バロネスの効果' },
            ],
          },
        ],
      },
    ],
  },

  // Ｗ：Ｐファンシーボール
  '4993187': {
    materialCheck: (env, m) =>
      m.length < 2
        ? '素材は2体以上です'
        : m.every((u) => isEffectMonster(env.def(u)))
          ? null
          : '効果モンスターのみ素材にできます',
    effects: [
      opponentOnly('① 相手のフィールド・墓地の効果を無効にし除外（相手用）', ['monster'], 'Ｗ：Ｐファンシーボール①'),
      opponentOnly('② 相手メインフェイズにL召喚（相手用）', ['monster'], 'Ｗ：Ｐファンシーボール②'),
    ],
  },

  // テラ・フォーミング
  '73628505': {
    effects: [
      {
        label: '発動：デッキからフィールド魔法を手札に加える',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから手札に加えるフィールド魔法',
            from: ['deck'],
            filter: { kind: ['spell'], spellType: ['field'] },
            min: 1,
            max: 1,
            then: (_, p) => [...p.map((u) => move(u, { zone: 'hand' }, 'サーチ')), { type: 'SHUFFLE_DECK' }],
          },
        ],
      },
    ],
  },

  // 月女神の至天（相手のモンスターの方が多い時だけ発動できる）
  '38817295': {
    effects: [{ ...opponentOnly('発動：効果を無効（相手用）', ['hand', 'spelltrap']), isCardActivation: true }],
  },

  // コピーキャット（相手の墓地のカードを使う）
  '88032456': {
    effects: [
      {
        ...opponentOnly('発動：相手の墓地のカードを自分の場に（相手用）', ['hand', 'spelltrap']),
        isCardActivation: true,
        speed: 1,
        condition: (env) => (env.toonWorld ? null : `自分フィールドに「${TW}」が必要です`),
      },
    ],
  },

  // コミックハンド（相手のモンスターに装備してコントロールを得る）
  '33453260': {
    effects: [
      {
        ...opponentOnly('発動：相手モンスターに装備してコントロールを得る（相手用）', ['hand', 'spelltrap']),
        isCardActivation: true,
        speed: 1,
        condition: (env) => (env.toonWorld ? null : `自分フィールドに「${TW}」が必要です`),
      },
    ],
  },
};
