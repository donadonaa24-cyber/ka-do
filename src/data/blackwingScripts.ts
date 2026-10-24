import {
  type Action,
  candidates,
  currentLevel,
  currentStats,
  effectSummonError,
  isNegated,
  missedTiming,
  type MonsterLocation,
} from '../engine/game';
import type { CardScript, EffectDef, Env, PickZone, ProcedureDef, Step } from '../engine/scripts';
import type { CardDef, Location } from '../engine/types';

// ルートガイドは未追加。相手用の処理と、耐性など既存の仕組みで扱えない処理はラベルに明記する。
// シムーンで置いた黒い旋風のエンドフェイズ処理は、専用の効果ボタンで実行する。

const BF = 'BF';
const BFD = 'ブラックフェザー・ドラゴン';
const isBF = (env: Env, u: string) => env.def(u).kind === 'monster' && !!env.def(u).archetypes?.includes(BF);
const isBFSynchro = (env: Env, u: string) => isBF(env, u) && env.def(u).frame === 'synchro';
const bfOrDragon = (env: Env, u: string) => isBFSynchro(env, u) || env.def(u).name === BFD;
const ownMonsters = (env: Env) => [...env.state.mz, ...env.state.emz].filter((u): u is string => !!u);
const faceUp = (env: Env, u: string) => env.state.cards[u].faceUp;
const ownFaceUp = (env: Env) => ownMonsters(env).filter((u) => faceUp(env, u));
const level = (env: Env, u: string) => currentLevel(env.state, env.ctx, u) ?? 0;
const atk = (env: Env, u: string) => currentStats(env.state, env.ctx, u).atk ?? 0;
const mainPhase = (env: Env) =>
  !env.state.opponentTurn && ['M1', 'M2'].includes(env.state.phase) ? null : '自分のメインフェイズにのみ使えます';
const move = (uid: string, to: Location, reason = '効果', extra: { faceUp?: boolean } = {}): Action => ({
  type: 'MOVE',
  uid,
  to,
  reason,
  ...extra,
});
const gy = (uid: string, reason = '効果'): Action => move(uid, { zone: 'gy' }, reason);
const banish = (uid: string, reason = 'コスト'): Action => move(uid, { zone: 'banished' }, reason);
const shuffle: Action = { type: 'SHUFFLE_DECK' };
const fail = (message: string): Action => ({ type: 'FAIL', message });
const ss = (
  uid: string,
  to: Location | null,
  note: string,
  extra: Partial<Extract<Action, { type: 'SPECIAL_SUMMON' }>> = {},
): Action => ({ type: 'SPECIAL_SUMMON', uid, to: to as MonsterLocation, note, ...extra });
const lock = (source: string, filter: import('../engine/filters').CardFilter): Action => ({
  type: 'EXTRA_LOCK',
  source,
  filter,
});
const selfCost = (to: 'gy' | 'banished'): Step => ({
  op: 'do',
  cost: true,
  then: (env) => [move(env.self, { zone: to }, 'コスト')],
});
const record = (label: string, from: EffectDef['from'], key?: string, steps: Step[] = []): EffectDef => ({
  label,
  from,
  key,
  limit: key ? 1 : undefined,
  opponentOnly: true,
  speed: 2,
  steps,
});
const manual = (label: string, from: EffectDef['from'] = ['monster']): EffectDef => ({
  label: `${label}（記録のみ・手動）`,
  from,
  applied: true,
  steps: [],
});
const noMaterials = (label: string, validate: ProcedureDef['validate'], oncePerTurn = false): ProcedureDef => ({
  label,
  hint: '出すゾーンを選択',
  from: [],
  materialsTo: 'gy',
  summonFrom: ['hand'],
  oncePerTurn,
  validate,
});
const bfInHand = (once = false) =>
  noMaterials(
    '① 別名の「ＢＦ」がいる場合：手札から特殊召喚',
    (env) =>
      ownFaceUp(env).some((u) => isBF(env, u) && env.def(u).name !== env.def(env.self).name)
        ? null
        : '自分フィールドに、このカードと別名の「ＢＦ」モンスターが必要です',
    once,
  );
const revive = (from: PickZone[], where: (env: Env, u: string) => boolean, note: string, position?: 'def'): Step[] => [
  { op: 'pick', prompt: '特殊召喚するモンスター（対象）', from, where, target: true, min: 1, max: 1, then: () => [] },
  {
    op: 'place',
    prompt: '対象のモンスターを出すゾーン',
    zone: 'monster',
    noSummonCheck: true,
    then: (env, z) => {
      const u = env.picks!.find((p) => p.length)![0];
      return [ss(u, z, note, { position })];
    },
  },
];
const summonCondition = (method: 'normal' | 'synchro' | 'link') => (env: Env) =>
  env.state.cards[env.self].summonType === method
    ? null
    : `${{ normal: '召喚', synchro: 'S召喚', link: 'L召喚' }[method]}した場合に使えます`;
const fresh = (env: Env, u: string) => {
  const c = env.state.cards[u];
  return c.faceUp && c.enteredTurn === env.state.turn && c.summonedEntry === c.entryId && !missedTiming(env.state, u);
};
const freshSynchros = (env: Env) =>
  ownFaceUp(env).filter(
    (u) =>
      env.state.cards[u].enteredTurn === env.state.turn &&
      env.state.cards[u].summonedEntry === env.state.cards[u].entryId &&
      env.def(u).frame === 'synchro' &&
      env.state.cards[u].summonType !== 'normal',
  );
/** 「この効果を発動するターン」の制約。既に場を離れたEXモンスターも召喚ログで確認する。 */
const alreadySummonedExtra = (env: Env, forbidden: (d: CardDef) => boolean) =>
  Object.values(env.ctx.db).some(
    (d) =>
      ['fusion', 'synchro', 'xyz', 'link'].includes(d.frame ?? '') &&
      forbidden(d) &&
      env.state.log.some(
        (l) =>
          l.turn === env.state.turn &&
          l.kind === 'summon' &&
          ['特殊', '融合', 'シンクロ', 'エクシーズ', 'リンク'].some((how) => l.text.includes(`${d.name}を${how}召喚`)),
      ),
  );
/** このファイルの効果ダメージはブラックフェザー・ドラゴン①で代替できる。LPコストとは区別する。 */
const damage = (env: Env, amount: number): Action[] => {
  const dragon = ownFaceUp(env).find((u) => env.def(u).name === BFD && !isNegated(env.state, u));
  return dragon
    ? [{ type: 'SET_COUNTERS', uid: dragon, value: env.state.cards[dragon].counters + 1 }]
    : [{ type: 'CHANGE_LP', delta: -amount }];
};
const synchroCheck =
  (ok: (env: Env, tuner: string, others: string[]) => boolean, message: string): CardScript['materialCheck'] =>
  (env, m, method) =>
    method !== 'synchro' ||
    m.some(
      (t) =>
        env.def(t).tuner &&
        m.filter((u) => u !== t).every((u) => !env.def(u).tuner) &&
        ok(
          env,
          t,
          m.filter((u) => u !== t),
        ),
    )
      ? null
      : message;
const bfTuner = synchroCheck((env, t) => isBF(env, t), '「ＢＦ」チューナーが必要です');
const abfTuner = { tunerWithMaterial: BF };
const whirlwindKey = (env: Env, source: string) =>
  `${env.def(env.self).name}:${env.self}:${env.state.cards[env.self].entryId}:${source}:${env.state.cards[source].entryId}`;
const normalBF = (env: Env) =>
  ownFaceUp(env).filter(
    (u) =>
      fresh(env, u) &&
      isBF(env, u) &&
      env.state.cards[u].summonType === 'normal' &&
      !env.state.effectUses[whirlwindKey(env, u)],
  );
const blackWhirlwindSource = (env: Env) =>
  freshSynchros(env).filter(
    (u) =>
      env.def(u).attribute === '闇' &&
      env.state.cards[u].movedFrom === 'extra' &&
      env.state.cards[u].movedAt > env.state.cards[env.self].movedAt,
  );
const markWhirlwindSource: Step = {
  op: 'pick',
  cost: true,
  prompt: '召喚された「ＢＦ」（この効果を使う召喚）',
  from: ['monsters'],
  where: (env, u) => normalBF(env).includes(u),
  min: 1,
  max: 1,
  then: (env, p) => [{ type: 'ACTIVATE_EFFECT', uid: env.self, silent: true, key: whirlwindKey(env, p[0]), limit: 1 }],
};

export const BLACKWING_OVERRIDES: Record<string, Partial<CardDef>> = {
  '49003716': { piercing: true },
  '9012916': { atkPerCounter: -700 },
  '69973414': { oncePerTurnActivation: true },
  '40366667': { oncePerTurnActivation: true },
  '73218989': { onlyBy: 'synchro' },
  '17465972': { cannotSpecialSummon: true },
  '16051717': abfTuner,
  '53389254': abfTuner,
  '31114334': { ...abfTuner, piercing: true },
  '23338098': abfTuner,
  '80773359': abfTuner,
};

export const BLACKWING_SCRIPTS: Record<string, CardScript> = {
  '2009101': {
    procedures: [bfInHand()],
    effects: [record('② 相手モンスターの攻守を半分にする（記録のみ・相手用）', ['monster'])],
  },
  '49003716': { procedures: [bfInHand()] },
  '73652465': {
    procedures: [bfInHand(true)],
    effects: [
      {
        label: '② S素材として墓地へ送られた場合：モンスターの表示形式を変更（記録のみ・手動）',
        from: ['gy'],
        trigger: true,
        targets: true,
        condition: (env) =>
          env.state.cards[env.self].movedTurn === env.state.turn &&
          ownMonsters(env).some(
            (u) => env.state.cards[u].materials?.includes(env.self) && env.state.cards[u].summonType === 'synchro',
          )
            ? null
            : 'このターンにS素材として墓地へ送られていません',
        steps: [],
      },
    ],
  },
  '77152542': {
    procedures: [bfInHand(true)],
    effects: [
      {
        label: '② 召喚・特殊召喚した時：他の「ＢＦ」のレベル分だけ自身のレベルを上げる',
        from: ['monster'],
        onSummon: true,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: 'レベルを参照する他の「ＢＦ」（対象）',
            target: true,
            from: ['monsters'],
            where: (env, u) => u !== env.self && faceUp(env, u) && isBF(env, u),
            min: 1,
            max: 1,
            then: (env, p) => [{ type: 'LEVEL_MOD', uid: env.self, delta: level(env, p[0]) }],
          },
        ],
      },
    ],
  },
  '81105204': {
    procedures: [bfInHand(true)],
    effects: [manual('② 1ターンに1度、魔法・罠の効果では破壊されない')],
  },
  '71187462': {
    procedures: [bfInHand(true)],
    effects: [
      {
        label: '② 自身とデッキの非チューナー「ＢＦ」を合計レベル8で墓地へ送り、ブラックフェザー・ドラゴンを特殊召喚',
        from: ['monster'],
        key: 'ＢＦ－無頼のヴァータ②',
        limit: 1,
        condition: (env) =>
          mainPhase(env) ??
          (alreadySummonedExtra(env, (d) => d.attribute !== '闇')
            ? 'このターンは既に闇属性以外をEXデッキから特殊召喚しています'
            : null),
        steps: [
          { op: 'do', cost: true, then: () => [lock('ＢＦ－無頼のヴァータ', { attribute: ['闇'] })] },
          {
            op: 'pick',
            prompt: '自身と合わせてレベル8になる、デッキのチューナー以外の「ＢＦ」1体以上',
            from: ['deck'],
            where: (env, u) => isBF(env, u) && !env.def(u).tuner,
            min: 1,
            max: 6,
            then: (env, p) =>
              level(env, env.self) + p.reduce((n, u) => n + level(env, u), 0) === 8
                ? [gy(env.self), ...p.map((u) => gy(u)), shuffle]
                : [fail('自身と選んだモンスターのレベル合計を8にしてください')],
          },
          {
            op: 'pick',
            prompt: 'EXデッキの「ブラックフェザー・ドラゴン」→ 出すゾーン',
            from: ['extra'],
            where: (env, u) => env.def(u).name === BFD,
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'ＢＦ－無頼のヴァータ②（S召喚ではない）')],
          },
        ],
      },
    ],
  },
  '14785765': {
    effects: [
      {
        label: '① 自分の表側表示カードを手札に戻し、墓地から特殊召喚して400ダメージ（デュエル中1度）',
        from: ['gy'],
        key: 'duel:ＢＦ－精鋭のゼピュロス',
        limit: 1,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: '手札に戻す自分の表側表示カード（コスト）',
            from: ['monsters', 'spelltraps'],
            where: faceUp,
            min: 1,
            max: 1,
            then: (_, p) => [move(p[0], { zone: 'hand' }, 'コスト')],
          },
          {
            op: 'place',
            prompt: 'ゼピュロスを出すゾーン',
            zone: 'monster',
            then: (env, z) => [ss(env.self, z, '自身の効果')],
          },
          { op: 'do', then: (env) => damage(env, 400) },
        ],
      },
    ],
  },
  '81470373': {
    effects: [
      {
        label: '① 手札の他の「ＢＦ」を除外し黒い旋風を置く。その後、自身をリリースなしで召喚するか墓地へ送る',
        from: ['hand'],
        key: 'ＢＦ－毒風のシムーン①',
        limit: 1,
        condition: (env) =>
          mainPhase(env) ?? (ownMonsters(env).length ? '自分フィールドにモンスターがいると発動できません' : null),
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: '除外する他の手札の「ＢＦ」（コスト）',
            from: ['hand'],
            where: (env, u) => u !== env.self && isBF(env, u),
            min: 1,
            max: 1,
            then: (_, p) => [banish(p[0])],
          },
          {
            op: 'pick',
            prompt: 'デッキから表側表示で置く「黒い旋風」',
            from: ['deck'],
            filter: { name: ['黒い旋風'] },
            min: 1,
            max: 1,
            zone: 'stz',
            then: (_, p, z) => [move(p[0], z!, 'シムーンで表側表示で置く', { faceUp: true }), shuffle],
          },
          {
            op: 'do',
            then: (env) => {
              const u = env.picks![1][0];
              return [
                {
                  type: 'ACTIVATE_EFFECT',
                  uid: u,
                  silent: true,
                  key: `シムーン配置:${u}:${env.state.cards[u].entryId}`,
                },
              ];
            },
          },
          {
            op: 'pick',
            prompt: 'シムーンを召喚するか墓地へ送るか',
            from: ['hand'],
            where: (env, u) => u === env.self,
            min: 1,
            max: 1,
            modes: ['リリースなしで召喚する', '墓地へ送る'],
            zone: 'monster',
            noSummonCheck: true,
            zoneIf: (_, __, mode) => mode === 0,
            then: (env, _, z, mode) => {
              if (mode === 1) return [gy(env.self)];
              if (z?.zone !== 'mz') return [fail('召喚先はメインモンスターゾーンです')];
              const index = env.state.summonGrants.length;
              const grant = {
                source: 'ＢＦ－毒風のシムーン',
                filter: { name: ['ＢＦ－毒風のシムーン'] },
                thisTurnOnly: true,
              };
              return [
                { type: 'GRANT_SUMMON', grant: { ...grant, extraSummon: true, noTribute: false } },
                { type: 'GRANT_SUMMON', grant: { ...grant, extraSummon: false, noTribute: true } },
                { type: 'NORMAL_SUMMON', uid: env.self, index: z.index, grant: index, noTributeGrant: index + 1 },
              ];
            },
          },
          { op: 'do', then: () => [lock('ＢＦ－毒風のシムーン', { attribute: ['闇'] })] },
        ],
      },
    ],
  },
  '8571567': {
    effects: [
      {
        label: '① 手札・フィールドから墓地へ送り、デッキの黒羽の旋風を表側表示で置く',
        from: ['hand', 'monster'],
        key: 'ＢＦ－嵐砂のシャマール①',
        limit: 1,
        steps: [
          selfCost('gy'),
          {
            op: 'pick',
            prompt: '表側表示で置く「黒羽の旋風」',
            from: ['deck'],
            filter: { name: ['黒羽の旋風'] },
            min: 1,
            max: 1,
            zone: 'stz',
            then: (_, p, z) => [move(p[0], z!, '表側表示で置く', { faceUp: true }), shuffle],
          },
        ],
      },
      {
        label:
          '② 墓地で「ＢＦ」Sかブラックフェザー・ドラゴンの特殊召喚を見た場合：除外して墓地の「ＢＦ」を回収し700ダメージ',
        from: ['gy'],
        key: 'ＢＦ－嵐砂のシャマール②',
        limit: 1,
        trigger: true,
        targets: true,
        condition: (env) =>
          freshSynchros(env).some(
            (u) => bfOrDragon(env, u) && env.state.cards[u].movedAt > env.state.cards[env.self].movedAt,
          )
            ? null
            : 'このカードが墓地にある状態で、該当するモンスターが特殊召喚されていません',
        steps: [
          selfCost('banished'),
          {
            op: 'pick',
            target: true,
            prompt: '手札に加える墓地の「ＢＦ」（対象）',
            from: ['gy'],
            where: isBF,
            min: 1,
            max: 1,
            then: (_, p) => [move(p[0], { zone: 'hand' })],
          },
          { op: 'do', then: (env) => damage(env, 700) },
        ],
      },
    ],
  },
  '70465810': {
    effects: [
      {
        label: '① 召喚した時：「ブラックフェザー・ドラゴン」の名が記されたカードをサーチ（スズリ以外）',
        from: ['monster'],
        onSummon: true,
        condition: summonCondition('normal'),
        steps: [
          {
            op: 'pick',
            prompt: '手札に加えるカード',
            from: ['deck'],
            where: (env, u) => env.def(u).name !== 'ＢＦ－幻耀のスズリ' && env.def(u).text.includes(`「${BFD}」`),
            min: 1,
            max: 1,
            then: (_, p) => [move(p[0], { zone: 'hand' }, 'サーチ'), shuffle],
          },
        ],
      },
      {
        label: '② モンスターをリリースし、幻耀トークン（星2・チューナー）を特殊召喚して700ダメージ',
        from: ['monster'],
        key: 'ＢＦ－幻耀のスズリ②',
        limit: 1,
        condition: (env) =>
          alreadySummonedExtra(env, (d) => d.frame !== 'synchro')
            ? 'このターンは既にSモンスター以外をEXデッキから特殊召喚しています'
            : null,
        steps: [
          { op: 'do', cost: true, then: () => [lock('ＢＦ－幻耀のスズリ', { frame: ['synchro'] })] },
          {
            op: 'pick',
            cost: true,
            prompt: 'リリースする自分のモンスター',
            from: ['monsters'],
            min: 1,
            max: 1,
            then: (_, p) => [gy(p[0], 'リリース')],
          },
          {
            op: 'place',
            prompt: '幻耀トークンを出すゾーン',
            zone: 'monster',
            then: (_, z) => [
              {
                type: 'CREATE_TOKEN',
                name: '幻耀トークン',
                level: 2,
                atk: 700,
                def: 700,
                attribute: '闇',
                race: '鳥獣族',
                tuner: true,
                to: z as MonsterLocation,
              },
            ],
          },
          { op: 'do', then: (env) => damage(env, 700) },
        ],
      },
    ],
  },
  '54594017': {
    procedures: [
      noMaterials(
        '① フィールドに攻撃力2000以上がいる場合：手札から特殊召喚',
        (env) =>
          candidates(env.state, ['monsters', 'oppMonsters']).some((u) => faceUp(env, u) && atk(env, u) >= 2000)
            ? null
            : 'フィールドに攻撃力2000以上のモンスターが必要です',
        true,
      ),
    ],
    effects: [
      {
        ...record(
          '② 墓地から除外し、相手の表側表示カードを破壊（デュエル中1度・記録のみ・相手用）',
          ['gy'],
          'duel:ＢＦ－下弦のサルンガ②',
          [selfCost('banished')],
        ),
        condition: (env) =>
          ownFaceUp(env).some((u) => isBFSynchro(env, u)) ? null : '自分フィールドに「ＢＦ」Sモンスターが必要です',
      },
    ],
  },
  '34976176': {
    effects: [
      {
        ...record(
          '① 自身を墓地へ送り、EXの「ＢＦ」Sかブラックフェザー・ドラゴンを墓地へ送って相手モンスターを弱体・無効（記録のみ・相手用）',
          ['hand', 'monster'],
          'ＢＦ－雪撃のチヌーク',
          [
            selfCost('gy'),
            {
              op: 'pick',
              prompt: '墓地へ送るEXモンスター',
              from: ['extra'],
              where: bfOrDragon,
              min: 1,
              max: 1,
              then: (_, p) => [gy(p[0])],
            },
          ],
        ),
        condition: (env) =>
          env.state.opponentTurn &&
          !ownFaceUp(env).some((u) => env.def(u).frame === 'synchro' && env.def(u).attribute === '闇')
            ? '相手ターンに使うには自分フィールドに闇属性Sモンスターが必要です'
            : null,
      },
    ],
  },
  '1475311': {
    effects: [
      {
        label: '発動：2枚ドローし、手札の闇属性1体を除外。いなければ手札を全て墓地へ送る',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          { op: 'do', then: () => [{ type: 'DRAW', count: 2 }] },
          {
            op: 'do',
            then: (env) =>
              env.state.hand.some((u) => env.def(u).kind === 'monster' && env.def(u).attribute === '闇')
                ? []
                : env.state.hand.map((u) => gy(u)),
          },
          {
            op: 'pick',
            prompt: '除外する手札の闇属性モンスター（いなければ0枚で決定）',
            from: ['hand'],
            filter: { kind: ['monster'], attribute: ['闇'] },
            range: (env) =>
              env.state.hand.some((u) => env.def(u).kind === 'monster' && env.def(u).attribute === '闇')
                ? [1, 1]
                : [0, 0],
            then: (env, p) => (p.length ? [banish(p[0], '効果')] : env.state.hand.map((u) => gy(u))),
          },
        ],
      },
    ],
  },
  '91351370': {
    effects: [
      { label: '発動：黒い旋風を表側表示で置く', from: ['hand', 'spelltrap'], isCardActivation: true, steps: [] },
      {
        label: '① 「ＢＦ」が召喚された時：その攻撃力未満の「ＢＦ」をデッキから手札に加える',
        from: ['spelltrap'],
        trigger: true,
        condition: (env) => (normalBF(env).length ? null : '未使用の「ＢＦ」の召喚直後に使えます'),
        steps: [
          markWhirlwindSource,
          {
            op: 'pick',
            prompt: '召喚されたモンスターより攻撃力が低い「ＢＦ」',
            from: ['deck'],
            min: 1,
            max: 1,
            where: (env, u) => {
              const source = env.picks![0][0];
              return ownFaceUp(env).includes(source) && isBF(env, u) && atk(env, u) < atk(env, source);
            },
            then: (_, p) => [move(p[0], { zone: 'hand' }, 'サーチ'), shuffle],
          },
        ],
      },
      {
        label: 'シムーンで置いた場合のエンドフェイズ処理：墓地へ送り1000ダメージ（ボタンで実行）',
        from: ['spelltrap'],
        applied: true,
        condition: (env) =>
          !env.state.opponentTurn &&
          env.state.phase === 'EP' &&
          env.state.effectUses[`シムーン配置:${env.self}:${env.state.cards[env.self].entryId}`]
            ? null
            : 'シムーンで置いたこのカードの、自分エンドフェイズの処理です',
        steps: [{ op: 'do', then: (env) => [gy(env.self), ...damage(env, 1000)] }],
      },
    ],
  },
  '7602800': {
    effects: [
      { label: '発動：黒羽の旋風を表側表示で置く', from: ['hand', 'spelltrap'], isCardActivation: true, steps: [] },
      {
        label:
          '① EXから闇属性Sを特殊召喚した場合：その攻撃力未満の墓地・除外の「ＢＦ」かブラックフェザー・ドラゴンを特殊召喚',
        from: ['spelltrap'],
        trigger: true,
        targets: true,
        key: '黒羽の旋風①',
        limit: 1,
        perCard: true,
        condition: (env) =>
          blackWhirlwindSource(env).length ? null : 'EXデッキから闇属性Sモンスターを特殊召喚した直後に使えます',
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'EXデッキから特殊召喚した闇属性Sモンスター',
            from: ['monsters'],
            where: (env, u) => blackWhirlwindSource(env).includes(u),
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'pick',
            target: true,
            prompt: '特殊召喚する墓地・除外のモンスター（対象）',
            from: ['gy', 'banished'],
            where: (env, u) =>
              (isBF(env, u) || env.def(u).name === BFD) &&
              (env.def(u).atk ?? 0) < atk(env, env.picks![0][0]) &&
              !effectSummonError(env.state, env.ctx, u),
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'place',
            prompt: '対象のモンスターを出すゾーン',
            zone: 'monster',
            then: (env, z) => [ss(env.picks![1][0], z, '黒羽の旋風①')],
          },
        ],
      },
      manual('② 闇属性モンスターの破壊を黒羽カウンター1つで代替', ['spelltrap']),
    ],
  },
  '69973414': {
    canActivateFromHand: (env) => ownFaceUp(env).filter((u) => isBF(env, u)).length >= 2,
    effects: [
      {
        label:
          '① 墓地・除外の「ＢＦ」チューナーと非チューナーを戻し、合計レベルの「ＢＦ」Sかブラックフェザー・ドラゴンをS召喚扱いで特殊召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: (env) =>
          env.loc(env.self)?.zone === 'hand' && ownFaceUp(env).filter((u) => isBF(env, u)).length < 2
            ? '手札から発動するには「ＢＦ」モンスターが2体以上必要です'
            : null,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: '戻す「ＢＦ」チューナー1体と非チューナー1体',
            from: ['gy', 'banished'],
            where: isBF,
            min: 2,
            max: 2,
            then: (env, p) =>
              p.filter((u) => env.def(u).tuner).length === 1
                ? [...p.map((u) => move(u, { zone: 'deck' }, 'コスト')), shuffle]
                : [fail('「ＢＦ」チューナー1体とチューナー以外1体を選んでください')],
          },
          {
            op: 'pick',
            prompt: '2体の合計レベルと同じSモンスター',
            from: ['extra'],
            where: (env, u) =>
              bfOrDragon(env, u) && env.def(u).level === env.picks![0].reduce((n, m) => n + (env.def(m).level ?? 0), 0),
            min: 1,
            max: 1,
            zone: 'monster',
            noSummonCheck: true,
            then: (_, p, z) => [ss(p[0], z, 'ＢＦ－ツインシャドウ（S召喚扱い）', { as: 'synchro' })],
          },
        ],
      },
    ],
  },
  '80254726': {
    canActivateFromHand: (env) => ownFaceUp(env).some((u) => bfOrDragon(env, u)),
    effects: [
      {
        ...record(
          '① 表側表示の「ＢＦ」を墓地へ送り、相手の発動を無効・破壊。任意でEXからブラックフェザー・ドラゴン（記録のみ・相手用）',
          ['hand', 'spelltrap'],
          undefined,
          [
            {
              op: 'pick',
              cost: true,
              prompt: '墓地へ送る自分の「ＢＦ」（コスト）',
              from: ['monsters'],
              where: (env, u) => isBF(env, u) && faceUp(env, u),
              min: 1,
              max: 1,
              then: (_, p) => [gy(p[0], 'コスト')],
            },
          ],
        ),
        isCardActivation: true,
        speed: 3,
        condition: (env) =>
          env.loc(env.self)?.zone === 'hand' && !ownFaceUp(env).some((u) => bfOrDragon(env, u))
            ? '手札から発動するには「ＢＦ」Sかブラックフェザー・ドラゴンが必要です'
            : null,
      },
    ],
  },
  '40366667': {
    canActivateFromHand: (env) => candidates(env.state, ['oppField']).length > 0,
    effects: [
      {
        ...record('① 特殊召喚を含む効果を無効（手札発動後の光・地・風属性の効果制限も記録のみ・相手用）', [
          'hand',
          'spelltrap',
        ]),
        isCardActivation: true,
        condition: (env) =>
          env.loc(env.self)?.zone === 'hand' && !candidates(env.state, ['oppField']).length
            ? '手札から発動するには相手フィールドにカードが必要です'
            : null,
      },
    ],
  },
  '10602628': {
    materialCheck: synchroCheck((env, t) => env.def(t).attribute === '闇', '闇属性チューナーが必要です'),
    effects: [
      {
        label: '① S召喚した場合：デッキの「ＢＦ」を墓地へ送り、そのレベルと同じになる',
        from: ['monster'],
        onSummon: true,
        condition: summonCondition('synchro'),
        key: 'ＢＦ－魔風のボレアース①',
        limit: 1,
        steps: [
          {
            op: 'pick',
            prompt: '墓地へ送るデッキの「ＢＦ」',
            from: ['deck'],
            where: isBF,
            min: 1,
            max: 1,
            then: (env, p) => [
              gy(p[0]),
              { type: 'LEVEL_MOD', uid: env.self, delta: (env.def(p[0]).level ?? 0) - level(env, env.self) },
              shuffle,
            ],
          },
        ],
      },
      record(
        '② 戦闘破壊した相手モンスターを、場・墓地の「ＢＦ」を除外して蘇生（記録のみ・相手用）',
        ['monster'],
        'ＢＦ－魔風のボレアース②',
      ),
    ],
  },
  '9012916': {
    effects: [
      manual('① 効果ダメージを黒羽カウンターに代替（追加したＢＦの自傷ダメージは自動対応）'),
      record(
        '③ 黒羽カウンターを全て取り除き相手の攻撃力を下げてダメージ（記録のみ・相手用）',
        ['monster'],
        'ブラックフェザー・ドラゴン③',
        [{ op: 'do', cost: true, then: (env) => [{ type: 'SET_COUNTERS', uid: env.self, value: 0 }] }],
      ),
    ],
  },
  '73218989': {
    materialCheck: synchroCheck((env, t) => env.def(t).frame === 'synchro', 'Sモンスターのチューナーが必要です'),
    procedures: [
      {
        label: 'Sチューナーとブラックフェザー・ドラゴンを場・墓地から除外して特殊召喚',
        hint: 'Sチューナー1体とブラックフェザー・ドラゴン1体',
        from: ['monsters', 'gy'],
        materialsTo: 'banished',
        summonFrom: ['extra'],
        materialFilter: (env, u) => env.def(u).name === BFD || (env.def(u).frame === 'synchro' && !!env.def(u).tuner),
        validate: (env, m) =>
          m.length === 2 &&
          m.every((u) => env.loc(u)?.zone === 'gy' || ownFaceUp(env).includes(u)) &&
          m.some((u, i) => env.def(u).frame === 'synchro' && env.def(u).tuner && env.def(m[1 - i]).name === BFD)
            ? null
            : '自分の表側表示フィールド・墓地のSチューナー1体とブラックフェザー・ドラゴン1体が必要です',
      },
    ],
    effects: [
      record('① 相手のモンスター効果発動ごとに黒羽カウンターを置き700ダメージ（記録のみ・相手用）', ['monster']),
      {
        ...record(
          '② 相手ターン：黒羽カウンター4つ以上の自身をリリースし全てのカードを破壊（記録のみ・相手用）',
          ['monster'],
          undefined,
          [selfCost('gy')],
        ),
        condition: (env) =>
          !env.state.opponentTurn
            ? '相手ターンに使えます'
            : env.state.cards[env.self].counters < 4
              ? '黒羽カウンターが4つ以上必要です'
              : null,
      },
    ],
  },
  '81983656': {
    materialCheck: synchroCheck(
      (env, t, o) => isBF(env, t) && o.every((u) => isBF(env, u)),
      '素材は「ＢＦ」チューナー＋チューナー以外の「ＢＦ」です',
    ),
    effects: [
      {
        label: '① 墓地のレベル5以上の鳥獣族を特殊召喚',
        from: ['monster'],
        key: 'ＢＦ Ｔ－漆黒のホーク・ジョー①',
        limit: 1,
        targets: true,
        steps: revive(
          ['gy'],
          (env, u) =>
            env.def(u).race === '鳥獣族' && (env.def(u).level ?? 0) >= 5 && !effectSummonError(env.state, env.ctx, u),
          'ホーク・ジョー①',
        ),
      },
      record(
        '② 自身への攻撃・効果の対象を別の「ＢＦ」に移す（記録のみ・相手用）',
        ['monster'],
        'ＢＦ Ｔ－漆黒のホーク・ジョー②',
      ),
    ],
  },
  '33236860': {
    materialCheck: synchroCheck(
      (env, t, o) => isBF(env, t) && o.length >= 2,
      '「ＢＦ」チューナー＋チューナー以外2体以上が必要です',
    ),
    effects: [
      record('① S召喚した時に2体まで破壊。このターンはバトルフェイズ不可（記録のみ・手動）', ['monster']),
      manual('② 相手ターンに1度、自分の「ＢＦ」は戦闘で破壊されない'),
    ],
  },
  '95040215': {
    effects: [
      {
        ...record(
          '① 特殊召喚時に800ダメージ・相手の攻守800ダウン（記録のみ・相手用）',
          ['monster'],
          'ＢＦ－星影のノートゥング①',
        ),
        onSummon: true,
      },
      {
        label: '② フィールドにいる間の「ＢＦ」の追加召喚権を使えるようにする',
        from: ['monster'],
        applied: true,
        key: 'ＢＦ－星影のノートゥング②',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'do',
            then: (env) => [
              {
                type: 'GRANT_SUMMON',
                grant: {
                  source: 'ＢＦ－星影のノートゥング',
                  sourceUid: env.self,
                  extraSummon: true,
                  noTribute: false,
                  filter: { kind: ['monster'], archetype: BF },
                  thisTurnOnly: true,
                },
              },
            ],
          },
        ],
      },
    ],
  },
  '53389254': {
    effects: [
      {
        label: '② S召喚した時：墓地の「Ａ ＢＦ」を特殊召喚',
        from: ['monster'],
        onSummon: true,
        targets: true,
        key: 'Ａ ＢＦ－五月雨のソハヤ②',
        limit: 1,
        condition: summonCondition('synchro'),
        steps: revive(
          ['gy'],
          (env, u) => !!env.def(u).archetypes?.includes('ABF') && !effectSummonError(env.state, env.ctx, u),
          'ソハヤ②',
        ),
      },
      {
        label: '③ 墓地へ送られたターン：別の墓地のソハヤを除外して自身を特殊召喚',
        from: ['gy'],
        key: 'Ａ ＢＦ－五月雨のソハヤ③',
        limit: 1,
        condition: (env) =>
          mainPhase(env) ??
          (env.state.cards[env.self].movedTurn === env.state.turn ? null : 'このターンに墓地へ送られていません'),
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: '除外する他の墓地のソハヤ',
            from: ['gy'],
            where: (env, u) => u !== env.self && env.def(u).name === 'Ａ ＢＦ－五月雨のソハヤ',
            min: 1,
            max: 1,
            then: (_, p) => [banish(p[0])],
          },
          {
            op: 'place',
            prompt: 'ソハヤを出すゾーン',
            zone: 'monster',
            then: (env, z) => [ss(env.self, z, 'ソハヤ③')],
          },
        ],
      },
    ],
  },
  '16051717': {
    effects: [record('② 他の自分の「ＢＦ」の数まで相手のカードを破壊（記録のみ・相手用）', ['monster'])],
  },
  '31114334': {
    effects: [
      {
        label: '② S召喚した時：素材にしたSモンスターの元々の攻撃力合計分、ターン終了まで攻撃力アップ',
        from: ['monster'],
        onSummon: true,
        applied: true,
        condition: summonCondition('synchro'),
        steps: [
          {
            op: 'do',
            then: (env) => [
              {
                type: 'STAT_MOD',
                uid: env.self,
                untilEnd: true,
                atk: (env.state.cards[env.self].materials ?? []).reduce(
                  (n, u) => n + (env.state.cards[u] && env.def(u).frame === 'synchro' ? (env.def(u).atk ?? 0) : 0),
                  0,
                ),
              },
            ],
          },
        ],
      },
      manual('③ 相手モンスター全てに1回ずつ攻撃できる（貫通は自動対応）'),
    ],
  },
  '54082269': {
    materialCheck: bfTuner,
    effects: [
      manual('① 他のカードの効果を受けない'),
      record('② 相手のモンスター効果発動時に楔カウンターを置く（記録のみ・相手用）', ['monster']),
      record('③ 楔カウンターのある相手モンスターのコントロールを得る（記録のみ・相手用）', ['monster']),
      record('④ 自分エンドフェイズに楔カウンターのあるモンスターを全て破壊（記録のみ・相手用）', ['monster']),
    ],
  },
  '17465972': {
    effects: [
      {
        label: '① 召喚した時：除外されたレベル4以下の「ＢＦ」を守備表示で特殊召喚',
        from: ['monster'],
        onSummon: true,
        targets: true,
        condition: summonCondition('normal'),
        steps: revive(
          ['banished'],
          (env, u) => isBF(env, u) && (env.def(u).level ?? 99) <= 4 && !effectSummonError(env.state, env.ctx, u),
          'アウステル①',
          'def',
        ),
      },
      {
        ...record('② 墓地から除外し、黒羽カウンターか相手の楔カウンターを置く（記録のみ・相手用）', ['gy'], undefined, [
          selfCost('banished'),
        ]),
        speed: 1,
      },
    ],
  },
  '23338098': {
    effects: [
      manual('② 墓地の「ＢＦ」の数×300攻撃力アップ'),
      {
        label: '③ 破壊され墓地へ送られた時：墓地の別名の鳥獣族Sを特殊召喚',
        from: ['gy'],
        trigger: true,
        targets: true,
        condition: (env) =>
          env.state.cards[env.self].movedTurn === env.state.turn &&
          ['mz', 'emz'].includes(env.state.cards[env.self].movedFrom ?? '') &&
          (env.state.cards[env.self].movedReason ?? '').includes('破壊') &&
          !missedTiming(env.state, env.self)
            ? null
            : 'フィールドで破壊され墓地へ送られた直後に使えます',
        steps: revive(
          ['gy'],
          (env, u) =>
            env.def(u).name !== env.def(env.self).name &&
            env.def(u).race === '鳥獣族' &&
            env.def(u).frame === 'synchro' &&
            !effectSummonError(env.state, env.ctx, u),
          'チドリ③',
        ),
      },
    ],
  },
  '80773359': {
    effects: [
      manual('② 効果では破壊されない'),
      {
        label: '③ 墓地の「ＢＦ」と同じレベルになる（デュエル中1度）',
        from: ['monster'],
        targets: true,
        key: 'duel:Ａ ＢＦ－神立のオニマル③',
        limit: 1,
        steps: [
          {
            op: 'pick',
            target: true,
            prompt: 'レベルを参照する墓地の「ＢＦ」',
            from: ['gy'],
            where: isBF,
            min: 1,
            max: 1,
            then: (env, p) => [
              { type: 'LEVEL_MOD', uid: env.self, delta: (env.def(p[0]).level ?? 0) - level(env, env.self) },
            ],
          },
        ],
      },
      manual('④ Sモンスターのみを素材にS召喚した場合、攻撃するダメージステップ中は攻撃力3000アップ'),
    ],
  },
  '9753964': {
    materialCheck: synchroCheck(
      (env, _t, o) =>
        o.length === 1 &&
        env.def(o[0]).race === 'ドラゴン族' &&
        env.def(o[0]).attribute === '闇' &&
        env.def(o[0]).frame === 'synchro',
      '非チューナーはドラゴン族・闇属性Sモンスター1体です',
    ),
    effects: [
      record(
        '① 相手の表側表示カードの効果をターン終了まで無効（記録のみ・相手用）',
        ['monster'],
        '琰魔竜 レッド・デーモン・アビス①',
      ),
      record(
        '② 戦闘ダメージを与えた時：墓地のチューナーを守備表示で特殊召喚（記録のみ・相手用）',
        ['monster'],
        '琰魔竜 レッド・デーモン・アビス②',
      ),
    ],
  },
  '36429703': {
    materialCheck: (env, m, method) =>
      method !== 'link' ||
      (m.length === 2 && m.every((u) => env.def(u).race === '鳥獣族' && env.def(u).attribute === '闇'))
        ? null
        : '鳥獣族・闇属性モンスター2体が必要です',
    effects: [
      manual('① L召喚時：デッキの鳥獣族・闇属性・星4を守備表示で特殊召喚し無効化。そのモンスターはL素材にできない'),
      manual('② 「ＲＲ」Xモンスターの効果発動時：デッキの「ＲＵＭ」をセットし、速攻魔法ならそのターン発動可能'),
    ],
  },
  '5041348': {
    effects: [
      record(
        '① 相手がモンスターの効果を発動した時、そのモンスターを除外（記録のみ・相手用）',
        ['monster'],
        '天威の龍鬼神①',
      ),
      record(
        '② 効果モンスターを戦闘破壊した場合、その元々の攻撃力分アップし再度モンスターに攻撃（記録のみ・相手用）',
        ['monster'],
        '天威の龍鬼神②',
      ),
    ],
  },
  '27572350': {
    materialCheck: synchroCheck(
      (env, _t, o) => o.every((u) => env.def(u).race === 'ドラゴン族'),
      '非チューナーはドラゴン族です',
    ),
    effects: [
      {
        label: '① 除外された光・闇属性モンスターを自分フィールドに特殊召喚（相手の除外は手動）',
        from: ['monster'],
        targets: true,
        key: '深淵の神獣ディス・パテル①',
        limit: 1,
        steps: revive(
          ['banished'],
          (env, u) =>
            env.def(u).kind === 'monster' &&
            ['光', '闇'].includes(env.def(u).attribute ?? '') &&
            !effectSummonError(env.state, env.ctx, u),
          'ディス・パテル①',
        ),
      },
      record(
        '② 除外されたカードを戻し、相手のモンスターを破壊するか効果を無効（記録のみ・相手用）',
        ['monster'],
        '深淵の神獣ディス・パテル②',
      ),
    ],
  },
  '22850702': {
    materialCheck: synchroCheck(
      (env, _t, o) => o.every((u) => ['光', '闇'].includes(env.def(u).attribute ?? '')),
      '非チューナーは光・闇属性です',
    ),
    procedures: [
      {
        label: '光・闇属性1体をチューナーとして扱いS召喚',
        hint: '光・闇属性のモンスター1体と、光・闇属性の非チューナー1体以上（合計レベル10）',
        from: ['monsters'],
        materialsTo: 'gy',
        summonFrom: ['extra'],
        summonType: 'synchro',
        validate: (env, m) =>
          m.length >= 2 &&
          m.every((u) => ownFaceUp(env).includes(u)) &&
          m.some(
            (t) =>
              ['光', '闇'].includes(env.def(t).attribute ?? '') &&
              m
                .filter((u) => u !== t)
                .every((u) => !env.def(u).tuner && ['光', '闇'].includes(env.def(u).attribute ?? '')),
          ) &&
          m.reduce((n, u) => n + level(env, u), 0) === 10
            ? null
            : '光・闇属性1体をチューナー扱いにし、光・闇属性の非チューナーと合計レベル10にしてください',
      },
    ],
    effects: [
      record('① 特殊召喚した場合：フィールドのカード1枚を除外（記録のみ・手動）', ['monster']),
      manual(
        '② S素材の元々の属性に応じた耐性（光：Sモンスターは相手の発動したモンスター効果を受けない／闇：自分のモンスターは戦闘で破壊されない）',
      ),
    ],
  },
  '28674152': {
    effects: [
      {
        label: '② 相手フィールドに「壊獣」がいる場合：手札から攻撃表示で特殊召喚',
        from: ['hand'],
        applied: true,
        condition: (env) =>
          mainPhase(env) ??
          (ownFaceUp(env).some((u) => env.def(u).archetypes?.includes('壊獣'))
            ? '自分フィールドの「壊獣」は1体までです'
            : candidates(env.state, ['oppMonsters']).some(
                  (u) => faceUp(env, u) && env.def(u).archetypes?.includes('壊獣'),
                )
              ? null
              : '相手フィールドに「壊獣」が必要です'),
        steps: [
          {
            op: 'place',
            prompt: 'ラディアンを出すゾーン',
            zone: 'monster',
            then: (env, z) => [ss(env.self, z, 'ラディアンの召喚条件', { position: 'atk' })],
          },
        ],
      },
      manual('① 相手モンスター1体をリリースし、手札から相手フィールドに攻撃表示で特殊召喚', ['hand']),
      manual('④ 壊獣カウンター2つを取り除きラディアントークンを特殊召喚（S素材にできない）'),
    ],
  },
};
