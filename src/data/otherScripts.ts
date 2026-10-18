import type { Action, MonsterLocation } from '../engine/game';
import type { CardScript, EffectDef, Env, Step } from '../engine/scripts';
import type { CardFilter } from '../engine/filters';
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

const ss = (uid: string, zone: Location | null, note: string, position: 'atk' | 'def' = 'atk'): Action => ({
  type: 'SPECIAL_SUMMON',
  uid,
  to: zone as MonsterLocation,
  position,
  note,
});
/** 装備カードとして魔法＆罠ゾーンに置く（ゾーンを選んでいなければ空いている一番左） */
const equipTo = (env: Env, uid: string, reason: string, zone: Location | null, target?: string): Action => {
  const to = zone ?? { zone: 'stz', index: Math.max(0, env.state.stz.indexOf(null)) };
  return move(uid, to, reason, { faceUp: true, equipTo: target });
};
const hasFreeStz = (env: Env) => (env.state.stz.includes(null) ? null : '魔法＆罠ゾーンに空きがありません');
const ownMonstersEmpty = (env: Env) =>
  [...env.state.mz, ...env.state.emz].some(Boolean) ? '自分フィールドにモンスターがいると発動できません' : null;
const DRAGUNITY: CardFilter = { kind: ['monster'], archetype: 'ドラグニティ' };

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

/** Ｎｏ．６０ 刻不知のデュガレスの①（X素材を2つ取り除いて3つから選ぶ） */
const dugares = (label: string, steps: Step[]): EffectDef => ({
  label,
  from: ['monster'],
  key: 'Ｎｏ．６０ 刻不知のデュガレス',
  limit: 1,
  condition: (env) => (env.state.cards[env.self].overlay.length >= 2 ? null : 'X素材が2つ必要です'),
  steps: [
    {
      op: 'do',
      cost: true,
      then: (env) =>
        env.state.cards[env.self].overlay
          .slice(0, 2)
          .map((uid) => ({ type: 'DETACH', target: env.self, uid }) as Action),
    },
    ...steps,
  ],
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
        materialFilter: (env, u) => isExtraFrame(env.def(u)) || env.def(u).race === '魔法使い族',
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
            zone: 'stz',
            then: (env, p, z) => {
              const counters = env.state.cards[env.self].counters + (env.def(p[0]).link ?? 0);
              return [
                equipTo(env, p[0], '装備魔法扱い', z, env.self),
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

  // ＰＳＹフレームギア・γ
  '38814750': {
    effects: [
      {
        ...opponentOnly('① 相手のモンスター効果の発動時：ドライバーと特殊召喚して無効＆破壊（相手用）', ['hand']),
        condition: ownMonstersEmpty,
      },
    ],
  },

  // ＰＳＹフレームギア・δ
  '74203495': {
    effects: [
      {
        ...opponentOnly('① 相手の魔法の発動時：ドライバーと特殊召喚して無効＆破壊（相手用）', ['hand']),
        condition: ownMonstersEmpty,
      },
    ],
  },

  // トゥーン・マーメイド
  '65458948': {
    procedures: [
      {
        label: '「トゥーン・ワールド」がある場合に手札から特殊召喚',
        hint: '',
        from: [],
        materialsTo: 'gy',
        summonFrom: ['hand'],
        validate: (env) => (env.toonWorld ? null : `自分フィールドに「${TW}」が必要です`),
      },
    ],
  },

  // 霊王の波動
  '40366667': {
    effects: [
      {
        ...opponentOnly('発動：特殊召喚する効果を含む効果を無効（相手用）', ['hand', 'spelltrap']),
        isCardActivation: true,
      },
    ],
  },

  // ドラグニティナイト－ハールーン
  '12496261': {
    effects: [
      {
        label: '① 特殊召喚時：墓地の「ドラグニティ」モンスターを装備',
        from: ['monster'],
        onSummon: true,
        key: 'ドラグニティナイト－ハールーン①',
        limit: 1,
        condition: hasFreeStz,
        steps: [
          {
            op: 'pick',
            prompt: '装備する自分の墓地の「ドラグニティ」モンスター',
            from: ['gy'],
            filter: DRAGUNITY,
            min: 1,
            max: 1,
            zone: 'stz',
            then: (env, p, z) => p.map((u) => equipTo(env, u, '装備魔法カード扱い', z, env.self)),
          },
        ],
      },
      {
        label: '② 墓地へ送られた時：自分の「ドラグニティ」モンスターに攻守1000アップの装備カードとして装備',
        from: ['gy'],
        key: 'ドラグニティナイト－ハールーン②',
        limit: 1,
        condition: (env) =>
          hasFreeStz(env) ??
          ([...env.state.mz, ...env.state.emz].some((u) => u && env.state.cards[u].faceUp && env.matches(u, DRAGUNITY))
            ? null
            : '自分フィールドに「ドラグニティ」モンスターがいません'),
        steps: [
          {
            op: 'pick',
            prompt: '装備先の自分フィールドの「ドラグニティ」モンスター',
            from: ['monsters'],
            filter: DRAGUNITY,
            where: (env, u) => env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            zone: 'stz',
            then: (env, p, z) => [equipTo(env, env.self, `${env.def(p[0]).name}に装備（攻守1000アップ）`, z, p[0])],
          },
        ],
      },
    ],
  },

  // Ｎｏ．６０ 刻不知のデュガレス
  '66011101': {
    effects: [
      dugares('① X素材2つ：2枚ドローして手札1枚を捨てる（次のドローフェイズをスキップ）', [
        { op: 'do', then: () => [{ type: 'DRAW', count: 2 }] },
        {
          op: 'pick',
          prompt: '捨てる手札1枚',
          from: ['hand'],
          min: 1,
          max: 1,
          then: (_, p) => p.map((u) => move(u, { zone: 'gy' }, '捨てる')),
        },
      ]),
      dugares('① X素材2つ：墓地のモンスターを守備表示で特殊召喚（次のメインフェイズ1をスキップ）', [
        {
          op: 'pick',
          prompt: '守備表示で特殊召喚する自分の墓地のモンスター',
          from: ['gy'],
          filter: { kind: ['monster'] },
          min: 1,
          max: 1,
          zone: 'monster',
          then: (_, p, z) => [ss(p[0], z, 'デュガレスの効果', 'def')],
        },
      ]),
    ],
  },

  // ドラグニティロード－ゲオルギアス
  '70522875': {
    materialCheck: (env, m) =>
      m.length < 2 ? '素材は2体以上です' : m.some((u) => env.def(u).tuner) ? null : 'チューナーを含める必要があります',
    effects: [
      {
        label: '① L召喚時：EXデッキ・墓地からレベル5以上の「ドラグニティ」を特殊召喚',
        from: ['monster'],
        onSummon: true,
        key: 'ドラグニティロード－ゲオルギアス①',
        limit: 1,
        steps: [
          {
            op: 'pick',
            prompt: '特殊召喚するレベル5以上の「ドラグニティ」モンスター（EXデッキ・墓地）',
            from: ['extra', 'gy'],
            filter: { ...DRAGUNITY, minLevel: 5 },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'ゲオルギアスの効果')],
          },
        ],
      },
      {
        ...opponentOnly(
          '③ 装備カードを墓地へ送り、相手の魔法・罠の効果を無効（相手用）',
          ['monster'],
          'ドラグニティロード－ゲオルギアス③',
        ),
        condition: (env) =>
          env.state.stz.some((u) => u && env.state.cards[u].faceUp && env.def(u).kind === 'monster')
            ? null
            : '装備カードがありません',
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
