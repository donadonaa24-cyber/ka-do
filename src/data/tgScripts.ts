import { type Action, currentLevel, missedTiming, type MonsterLocation, oppMonsterSlots } from '../engine/game';
import type { CardFilter } from '../engine/filters';
import { linkedZonesOf } from '../engine/rules';
import type { CardScript, EffectDef, Env, PickZone, ProcedureDef, Step } from '../engine/scripts';
import type { CardDef, GameState, Location } from '../engine/types';
import { TG_CARD_DATA } from './tgCards.generated';

// ＴＧデッキのカードの召喚条件・効果。相手がいる時だけ意味がある効果は、記録するだけにする。

const TG = 'TG';
const TG_MONSTER: CardFilter = { kind: ['monster'], archetype: TG };

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
const draw = (count = 1): Action => ({ type: 'DRAW', count });
const negateUntilLeave = (uid: string, by: string): Action => ({ type: 'NEGATE_CARD', uid, by, untilLeave: true });
const shuffle: Action = { type: 'SHUFFLE_DECK' };
const withShuffle = (env: Env, picked: string[], actions: Action[]): Action[] =>
  picked.some((u) => env.loc(u)?.zone === 'deck') ? [...actions, shuffle] : actions;
const fail = (message: string): Action => ({ type: 'FAIL', message });

const mainPhase = (env: Env) =>
  !env.state.opponentTurn && (env.state.phase === 'M1' || env.state.phase === 'M2')
    ? null
    : '自分のメインフェイズにのみ発動できます';
const oppMainPhase = (env: Env) =>
  env.state.opponentTurn && (env.state.phase === 'M1' || env.state.phase === 'M2')
    ? null
    : '相手のメインフェイズにのみ発動できます（メニューの「相手ターンへ」で相手ターンに進めます）';
const oppTurn = (env: Env) =>
  env.state.opponentTurn ? null : '相手ターンにのみ発動できます（メニューの「相手ターンへ」で相手ターンに進めます）';
const hasFreeStz = (env: Env) => (env.state.stz.includes(null) ? null : '魔法＆罠ゾーンに空きがありません');
/** 空いているメインモンスターゾーン（効果で何体も出す時に、左から順に使う） */
const freeMz = (state: GameState): MonsterLocation[] =>
  state.mz.flatMap((u, index) => (u ? [] : [{ zone: 'mz' as const, index }]));

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
const search = (prompt: string, filter: CardFilter, where?: (env: Env, uid: string) => boolean): Step => ({
  op: 'pick',
  prompt,
  from: ['deck'],
  filter,
  where,
  min: 1,
  max: 1,
  then: (env, p) => withShuffle(env, p, [toHand(p[0], 'サーチ')]),
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
/** 対象のモンスターを特殊召喚する（対象は発動時、出すゾーンは解決時に選ぶ） */
const ssTarget = (
  prompt: string,
  from: PickZone[],
  where: (env: Env, uid: string) => boolean,
  note: string,
  opts: { position?: 'atk' | 'def'; negate?: string } = {},
): Step[] => [
  { op: 'pick', prompt, target: true, from, where, min: 1, max: 1, then: () => [] },
  {
    op: 'place',
    prompt: '対象のモンスターを出すゾーンを選択',
    zone: 'monster',
    then: (env, z) => {
      const u = env.picks![0][0];
      return [ss(u, z, note, opts.position), ...(opts.negate ? [negateUntilLeave(u, opts.negate)] : [])];
    },
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
const trapLogOnly = (label: string, key?: string): EffectDef => ({
  ...logOnly(label, ['hand', 'spelltrap'], key),
  isCardActivation: true,
});

// ===== 条件 =====

const isTG = (env: Env, u: string) => !!env.def(u).archetypes?.includes(TG);
const ownMonsters = (env: Env) => [...env.state.mz, ...env.state.emz].filter((u): u is string => !!u);
const ownFaceUpMonsters = (env: Env) => ownMonsters(env).filter((u) => env.state.cards[u].faceUp);
const oppMonsters = (env: Env) => (env.state.opp ? oppMonsterSlots(env.state.opp) : []).filter((u): u is string => !!u);
const onField = (env: Env, u: string) => ['mz', 'emz'].includes(env.loc(u)?.zone ?? '');
/** 「ＴＧ－オールクリア」①：フィールドの「ＴＧ」モンスターは機械族になる */
const allClearOn = (env: Env) =>
  [...env.state.stz, env.state.fz].some(
    (u) => !!u && env.state.cards[u].faceUp && env.def(u).name === 'ＴＧ－オールクリア',
  );
const isMachineTG = (env: Env, u: string) =>
  isTG(env, u) && (env.def(u).race === '機械族' || (onField(env, u) && allClearOn(env)));
const needMachineTG = (env: Env) =>
  ownFaceUpMonsters(env).some((u) => isMachineTG(env, u))
    ? null
    : '自分フィールドに機械族の「ＴＧ」モンスターが必要です（「ＴＧ－オールクリア」があればＴＧモンスターは機械族）';
const lv4TG = (env: Env, u: string) => isTG(env, u) && env.def(u).kind === 'monster' && (env.def(u).level ?? 99) <= 4;

/** このターン、フィールドで破壊されて墓地へ送られた */
const destroyedFromFieldThisTurn = (env: Env) => {
  const inst = env.state.cards[env.self];
  return inst.movedTurn === env.state.turn &&
    ['mz', 'emz'].includes(inst.movedFrom ?? '') &&
    (inst.movedReason ?? '').includes('破壊')
    ? null
    : 'このターンにフィールドで破壊されて墓地へ送られていません';
};
/** このターン、モンスターゾーンから墓地へ送られた */
const sentFromFieldThisTurn = (env: Env) => {
  const inst = env.state.cards[env.self];
  return inst.movedTurn === env.state.turn && ['mz', 'emz'].includes(inst.movedFrom ?? '')
    ? null
    : 'このターンにモンスターゾーンから墓地へ送られていません';
};
/** S召喚したこのカード */
const synchroSummoned = (env: Env) =>
  env.state.cards[env.self].summonType === 'synchro' ? null : 'S召喚した時に発動する効果です';

// ===== S素材の条件 =====

/**
 * 素材の分け方（チューナー1体とチューナー以外）。ＴＧ タンク・ラーヴァは「ＴＧ」Sモンスターの素材ならチューナー以外にもなれる
 */
function synchroSplits(env: Env, materials: string[]): { tuner: string; others: string[] }[] {
  const target = env.def(env.self);
  const asNonTuner = (u: string) => {
    const d = env.def(u);
    return !d.tuner || (!!d.nonTunerFor && !!target.archetypes?.includes(d.nonTunerFor));
  };
  return materials
    .filter((t) => env.def(t).tuner)
    .map((t) => ({ tuner: t, others: materials.filter((u) => u !== t) }))
    .filter((s) => s.others.every(asNonTuner));
}
const isSynchro = (env: Env, u: string) => env.def(u).frame === 'synchro';
/** チューナー＋チューナー以外の◯◯（条件を満たす分け方があるか） */
const synchroCheck =
  (
    message: string,
    ok: (env: Env, tuner: string, others: string[]) => boolean,
  ): NonNullable<CardScript['materialCheck']> =>
  (env, materials, method) => {
    if (method !== 'synchro') return null;
    return synchroSplits(env, materials).some((s) => ok(env, s.tuner, s.others)) ? null : message;
  };
const nonTunersTG = synchroCheck('チューナー以外の素材は「ＴＧ」モンスターにしてください', (env, _t, o) =>
  o.every((u) => isTG(env, u)),
);
const oneNonTuner = synchroCheck('チューナー以外の素材は1体です', (_e, _t, o) => o.length === 1);
const synchroOnly = (min: number) =>
  synchroCheck(
    `素材はSモンスターのチューナー＋チューナー以外のSモンスター${min}体以上です`,
    (env, t, o) => isSynchro(env, t) && o.length >= min && o.every((u) => isSynchro(env, u)),
  );

// ===== よく使う効果 =====

/** 「フィールドのこのカードが破壊され墓地へ送られたターンのエンドフェイズ」：デッキから「ＴＧ」モンスターをサーチ */
const endPhaseSearch = (no: string, name: string): EffectDef => ({
  label: `${no} 破壊され墓地へ送られたターンのエンドフェイズ：デッキから「${name}」以外の「ＴＧ」モンスターを手札に加える`,
  from: ['gy'],
  key: `${name}:エンドフェイズ`,
  limit: 1,
  perCard: true,
  trigger: true,
  condition: (env) => (env.state.phase === 'EP' ? destroyedFromFieldThisTurn(env) : 'エンドフェイズに発動できます'),
  steps: [search(`デッキから手札に加える「${name}」以外の「ＴＧ」モンスター`, { ...TG_MONSTER, excludeName: [name] })],
});

/** 「フィールドのこのカードが破壊された場合」：1枚ドロー（発動する効果） */
const destroyedDraw = (no: string, name: string): EffectDef => ({
  label: `${no} 破壊された場合：1枚ドロー`,
  from: ['gy', 'banished'],
  key: `${name}:破壊ドロー`,
  limit: 1,
  perCard: true,
  trigger: true,
  condition: (env) => {
    const inst = env.state.cards[env.self];
    return inst.movedTurn === env.state.turn &&
      ['mz', 'emz'].includes(inst.movedFrom ?? '') &&
      (inst.movedReason ?? '').includes('破壊')
      ? null
      : 'このターンにフィールドで破壊されていません';
  },
  steps: [{ op: 'do', then: () => [draw(1)] }],
});

/**
 * 「相手メインフェイズに、このカードを含む自分フィールドのモンスターを素材としてＳ召喚を行う」
 * （ＴＧ ワンダー・マジシャンなど。相手ターンの練習で使う）
 */
const quickSynchro = (no: string, name: string, key?: string): EffectDef => ({
  label: `${no} 相手メインフェイズ：このカードを含む自分フィールドのモンスターでS召喚`,
  from: ['monster'],
  key,
  limit: key ? 1 : undefined,
  perCard: !!key,
  speed: 2,
  condition: oppMainPhase,
  steps: [
    {
      op: 'pick',
      prompt: 'S召喚するSモンスター（EXデッキ）',
      from: ['extra'],
      filter: { kind: ['monster'], frame: ['synchro'] },
      min: 1,
      max: 1,
      noSummonCheck: true,
      then: () => [],
    },
    {
      op: 'pick',
      prompt: `S素材にするモンスター（「${name}」を含める）→ 出すゾーン`,
      from: ['monsters', 'hand'],
      where: (env, u) =>
        onField(env, u)
          ? env.state.cards[u].faceUp
          : ownFaceUpMonsters(env).some((m) => !!env.def(m).handSynchroFor) && isTG(env, u) && !env.def(u).tuner,
      range: () => [2, 6],
      zone: 'monster',
      noSummonCheck: true,
      then: (env, p, z) =>
        p.includes(env.self)
          ? [
              {
                type: 'PROCEDURE_SUMMON',
                method: 'synchro',
                uid: env.picks![0][0],
                materials: p,
                to: z as MonsterLocation,
                by: `${name}の効果`,
              },
            ]
          : [fail(`「${name}」を素材に含めてください`)],
    },
  ],
});

/** 自分の墓地の「ＴＧ」モンスター○体をデッキに戻し、2枚ドロー（貪欲な壺・ＴＧＸ３－ＤＸ２） */
const returnAndDraw = (count: number, filter: CardFilter, what: string): Step[] => [
  {
    op: 'pick',
    prompt: `デッキに戻す自分の墓地の${what}（対象・${count}体）`,
    target: true,
    from: ['gy'],
    filter,
    min: count,
    max: count,
    then: (_, p) => p.map((u) => move(u, { zone: 'deck' }, '効果でデッキに戻す')),
  },
  { op: 'do', then: () => [shuffle, draw(2)] },
];

/** ＴＧ トライデント・ランチャー（リンク先にだけ出せる） */
const TRIDENT: CardDef = TG_CARD_DATA.find((c) => c.id === '50750868')!;
const tridentZone = (state: GameState, self: string, loc: Location) =>
  loc.zone === 'mz' && linkedZonesOf(state, self, TRIDENT).includes(loc.index);

// ===== カードの見た目以外の性質 =====

export const TG_OVERRIDES: Record<string, Partial<CardDef>> = {
  // ＴＧ ラッシュ・ライノ①
  '36687247': { attackBonus: 400 },
  // ＴＧ ドリル・フィッシュ②
  '30348744': { directAttack: true },
  // ＴＧ パワー・グラディエイター①
  '24943456': { piercing: true },
  // ＴＧ タンク・ラーヴァ①
  '74627016': { nonTunerFor: TG },
  // ＴＧ サイバー・マジシャン
  '64910482': { handSynchroFor: TG },
  // ＴＧ ハルバード・キャノン・ＴＧ グレイヴ・ブラスター：S召喚でしか特殊召喚できない
  '97836203': { onlyBy: 'synchro' },
  '95973569': { onlyBy: 'synchro' },
  // 篝火・次元障壁：このカード名のカードは1ターンに1枚しか発動できない
  '85106525': { oncePerTurnActivation: true },
  '83326048': { oncePerTurnActivation: true },
};

// ===== カードごとの召喚条件・効果 =====

const handProcedure = (label: string, validate: ProcedureDef['validate'], oncePerTurn = false): ProcedureDef => ({
  label,
  hint: '出すゾーンを選択',
  from: [],
  materialsTo: 'gy',
  summonFrom: ['hand'],
  oncePerTurn,
  validate,
});

export const TG_SCRIPTS: Record<string, CardScript> = {
  // ＴＧ ストライカー
  '1315120': {
    procedures: [
      handProcedure('① 相手フィールドにのみモンスターがいる時、手札から特殊召喚', (env) =>
        ownMonsters(env).length
          ? '自分フィールドにモンスターがいると特殊召喚できません'
          : oppMonsters(env).length
            ? null
            : '相手フィールドにモンスターがいません（相手の盤面を置くと使えます）',
      ),
    ],
    effects: [endPhaseSearch('②', 'ＴＧ ストライカー')],
  },

  // ＴＧ ワーウルフ
  '293542': {
    effects: [
      {
        label: '① レベル4以下のモンスターが特殊召喚された時：手札から特殊召喚',
        from: ['hand'],
        trigger: true,
        condition: (env) => {
          const s = env.state;
          const fresh = [...ownMonsters(env), ...oppMonsters(env)].some((u) => {
            const inst = s.cards[u];
            const lv = currentLevel(s, env.ctx, u);
            return (
              inst.faceUp &&
              inst.enteredTurn === s.turn &&
              inst.summonedEntry === inst.entryId &&
              inst.summonType !== 'normal' &&
              lv !== undefined &&
              lv <= 4 &&
              !missedTiming(s, u)
            );
          });
          return fresh ? null : 'レベル4以下のモンスターが特殊召喚された直後に発動できます';
        },
        steps: [ssSelf('自身の効果')],
      },
      endPhaseSearch('②', 'ＴＧ ワーウルフ'),
    ],
  },

  // ＴＧ ラッシュ・ライノ（①は攻撃するダメージステップの間、攻撃力400アップ）
  '36687247': { effects: [endPhaseSearch('②', 'ＴＧ ラッシュ・ライノ')] },

  // ＴＧ スクリュー・サーペント
  '11234702': {
    effects: [
      {
        label: '① 召喚・特殊召喚した場合：墓地のレベル4以下の「ＴＧ」を特殊召喚（効果無効）',
        from: ['monster'],
        key: 'ＴＧ スクリュー・サーペント①',
        limit: 1,
        onSummon: true,
        trigger: true,
        targets: true,
        steps: ssTarget(
          '特殊召喚する自分の墓地のレベル4以下の「ＴＧ」モンスター（「ＴＧ スクリュー・サーペント」以外・対象）',
          ['gy'],
          (env, u) => lv4TG(env, u) && env.def(u).name !== 'ＴＧ スクリュー・サーペント',
          'ＴＧ スクリュー・サーペントの効果・効果無効',
          { negate: 'ＴＧ スクリュー・サーペント' },
        ),
      },
      {
        label: '② 墓地から除外：自分の「ＴＧ」モンスター1体のレベルを1つ上げるか下げる',
        from: ['gy'],
        key: 'ＴＧ スクリュー・サーペント②',
        limit: 1,
        targets: true,
        steps: [
          selfTo('banished'),
          {
            op: 'pick',
            prompt: 'レベルを変える自分フィールドの「ＴＧ」モンスター（対象）',
            target: true,
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && isTG(env, u) && env.def(u).level !== undefined,
            min: 1,
            max: 1,
            modes: ['レベルを1つ上げる', 'レベルを1つ下げる'],
            then: (_, p, __, mode) =>
              p.map((u) => ({ type: 'LEVEL_MOD', uid: u, delta: mode === 0 ? 1 : -1, untilEnd: true }) as Action),
          },
        ],
      },
    ],
  },

  // ＴＧ ブースター・ラプトル
  '48633301': {
    procedures: [
      handProcedure(
        '① 自分フィールドに「ＴＧ」モンスターがいる時、手札から特殊召喚（1ターンに1度）',
        (env) =>
          ownFaceUpMonsters(env).some((u) => isTG(env, u)) ? null : '自分フィールドに「ＴＧ」モンスターが必要です',
        true,
      ),
    ],
    effects: [endPhaseSearch('②', 'ＴＧ ブースター・ラプトル')],
  },

  // ＴＧ タンク・ラーヴァ（①は「ＴＧ」SモンスターのS素材にする時、チューナー以外として扱える）
  '74627016': {
    effects: [
      {
        label: '② 「ＴＧ」SモンスターのS素材になった場合：「ＴＧトークン」を特殊召喚',
        from: ['gy'],
        key: 'ＴＧ タンク・ラーヴァ②',
        limit: 1,
        trigger: true,
        condition: (env) => {
          const s = env.state;
          const inst = s.cards[env.self];
          const used = ownMonsters(env).some(
            (u) =>
              s.cards[u].summonType === 'synchro' &&
              s.cards[u].enteredTurn === s.turn &&
              isTG(env, u) &&
              !!s.cards[u].materials?.includes(env.self),
          );
          return inst.movedTurn === s.turn && used ? null : 'このターンに「ＴＧ」SモンスターのS素材になっていません';
        },
        steps: [
          {
            op: 'place',
            prompt: '「ＴＧトークン」を出すゾーンを選択',
            zone: 'monster',
            then: (_, z) => [
              {
                type: 'CREATE_TOKEN',
                name: 'ＴＧトークン',
                level: 1,
                atk: 0,
                def: 0,
                attribute: '地',
                race: '機械族',
                to: z as MonsterLocation,
                position: 'atk',
              },
            ],
          },
        ],
      },
    ],
  },

  // ＴＧ ギア・ゾンビ
  '94350039': {
    effects: [
      {
        label: '① 自分の「ＴＧ」モンスター1体を対象に、手札から特殊召喚（対象の攻撃力1000ダウン）',
        from: ['hand'],
        key: 'ＴＧ ギア・ゾンビ',
        limit: 1,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: '攻撃力を下げる自分フィールドの「ＴＧ」モンスター（対象）',
            target: true,
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && isTG(env, u),
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
              { type: 'STAT_MOD', uid: env.picks![0][0], atk: -1000, source: 'ＴＧ ギア・ゾンビ' },
            ],
          },
        ],
      },
    ],
  },

  // ＴＧ ドリル・フィッシュ（②は直接攻撃できる）
  '30348744': {
    effects: [
      {
        label: '① 自分フィールドのモンスターが「ＴＧ」だけの時：手札から特殊召喚',
        from: ['hand'],
        key: 'ＴＧ ドリル・フィッシュ①',
        limit: 1,
        condition: (env) => {
          const mons = ownMonsters(env);
          return mons.length && mons.every((u) => env.state.cards[u].faceUp && isTG(env, u))
            ? null
            : '自分フィールドのモンスターが「ＴＧ」モンスターだけの時に発動できます';
        },
        steps: [ssSelf('自身の効果')],
      },
      {
        label: '③ 自分の「ＴＧ」が戦闘ダメージを与えた時：相手のモンスター1体を破壊',
        from: ['monster'],
        key: 'ＴＧ ドリル・フィッシュ③',
        limit: 1,
        trigger: true,
        damageStep: true,
        targets: true,
        condition: (env) => {
          const b = env.state.battle;
          if (!b || b.byOpp || b.step !== 'end' || !isTG(env, b.attacker))
            return '自分の「ＴＧ」モンスターが相手に戦闘ダメージを与えた時に発動できます';
          return oppMonsters(env).length ? null : '相手フィールドにモンスターがいません';
        },
        steps: [
          {
            op: 'pick',
            prompt: '破壊する相手フィールドのモンスター（対象）',
            target: true,
            from: ['oppMonsters'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '効果で破壊')),
          },
        ],
      },
    ],
  },

  // ＴＧ ロケット・サラマンダー
  '77392987': {
    effects: [
      {
        label: '① 自分の「ＴＧ」をリリース：元々のカード名が異なる「ＴＧ」モンスターをデッキから特殊召喚',
        from: ['monster'],
        key: 'ＴＧ ロケット・サラマンダー①',
        limit: 1,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：リリースする自分フィールドの「ＴＧ」モンスター',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && isTG(env, u),
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, 'リリース')),
          },
          {
            op: 'pick',
            prompt: 'デッキから特殊召喚する「ＴＧ」モンスター（リリースしたモンスターと元々のカード名が異なる）',
            from: ['deck'],
            filter: TG_MONSTER,
            where: (env, u) => env.def(u).name !== env.def(env.picks![0][0]).name,
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, 'ＴＧ ロケット・サラマンダーの効果')]),
          },
        ],
      },
      {
        label: '② 機械族の「ＴＧ」がいる時：墓地のレベル4以下の「ＴＧ」を守備表示で特殊召喚（効果無効）',
        from: ['monster'],
        key: 'ＴＧ ロケット・サラマンダー②',
        limit: 1,
        targets: true,
        condition: needMachineTG,
        steps: ssTarget(
          '守備表示で特殊召喚する自分の墓地のレベル4以下の「ＴＧ」モンスター（対象）',
          ['gy'],
          lv4TG,
          'ＴＧ ロケット・サラマンダーの効果・効果無効',
          { position: 'def', negate: 'ＴＧ ロケット・サラマンダー' },
        ),
      },
    ],
  },

  // ＴＧ サイバー・マジシャン（フィールドのこのカードを「ＴＧ」SモンスターのS素材にする時、手札の「ＴＧ」も素材にできる）
  '64910482': { effects: [endPhaseSearch('①', 'ＴＧ サイバー・マジシャン')] },

  // ＴＧ メタル・スケルトン
  '66733743': {
    effects: [
      {
        label: '① モンスターが戦闘か相手の効果で破壊された場合：手札から特殊召喚',
        from: ['hand'],
        key: 'ＴＧ メタル・スケルトン①',
        limit: 1,
        trigger: true,
        condition: (env) => {
          const s = env.state;
          const hit = Object.values(s.cards).some((inst) => {
            const why = inst.movedReason ?? '';
            return (
              inst.movedTurn === s.turn &&
              ['mz', 'emz', 'omz', 'oemz'].includes(inst.movedFrom ?? '') &&
              (why.includes('戦闘') || (why.includes('破壊') && (s.opponentTurn || !!inst.opp)))
            );
          });
          return hit ? null : 'このターンに、モンスターが戦闘か相手の効果で破壊されていません';
        },
        steps: [ssSelf('自身の効果')],
      },
      {
        label: '② 「ＴＧ」が破壊される代わりに、このカードを除外（破壊されるはずのモンスターはフィールドに残す）',
        from: ['monster', 'gy'],
        key: 'ＴＧ メタル・スケルトン②',
        limit: 1,
        applied: true,
        steps: [selfTo('banished', '「ＴＧ」モンスターの破壊の身代わり')],
      },
    ],
  },

  // 死者蘇生
  '83764718': {
    effects: [
      {
        label: '発動：自分の墓地のモンスター1体を特殊召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        targets: true,
        steps: ssTarget(
          '特殊召喚する自分の墓地のモンスター（対象）',
          ['gy'],
          (env, u) => env.def(u).kind === 'monster',
          '死者蘇生',
        ),
      },
    ],
  },

  // 貪欲な壺
  '67169062': {
    effects: [
      {
        label: '発動：墓地のモンスター5体をデッキに戻し、2枚ドロー',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: returnAndDraw(5, { kind: ['monster'] }, 'モンスター'),
      },
    ],
  },

  // 化石調査
  '47325505': {
    effects: [
      {
        label: '発動：デッキからレベル6以下の恐竜族モンスターを手札に加える',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          search('デッキから手札に加えるレベル6以下の恐竜族モンスター', {
            kind: ['monster'],
            race: ['恐竜族'],
            maxLevel: 6,
          }),
        ],
      },
    ],
  },

  // 篝火
  '85106525': {
    effects: [
      {
        label: '発動：デッキからレベル4以下の炎族モンスターを手札に加える',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          search('デッキから手札に加えるレベル4以下の炎族モンスター', {
            kind: ['monster'],
            race: ['炎族'],
            maxLevel: 4,
          }),
        ],
      },
    ],
  },

  // ＴＧ－ブレイクリミッター（①②はいずれか1つ）
  '28189908': {
    effects: [
      {
        label: '① 手札を1枚捨て、デッキから「ＴＧ」モンスター2体（同名カードは1枚まで）を手札に加える',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        key: 'ＴＧ－ブレイクリミッター',
        limit: 1,
        steps: [
          discardCost(),
          {
            op: 'pick',
            prompt: 'デッキから手札に加える「ＴＧ」モンスター2体（カード名が異なる）',
            from: ['deck'],
            filter: TG_MONSTER,
            min: 2,
            max: 2,
            then: (env, p) =>
              env.def(p[0]).name === env.def(p[1]).name
                ? [fail('同名カードは1枚までです')]
                : withShuffle(
                    env,
                    p,
                    p.map((u) => toHand(u, 'サーチ')),
                  ),
          },
        ],
      },
      {
        label:
          '② 墓地から除外：墓地の「ＴＧ」モンスター1体をデッキに戻す（機械族の「ＴＧ」がいれば手札に加えてもよい）',
        from: ['gy'],
        key: 'ＴＧ－ブレイクリミッター',
        limit: 1,
        steps: [
          selfTo('banished'),
          {
            op: 'pick',
            prompt: 'デッキに戻すか手札に加える自分の墓地の「ＴＧ」モンスター（対象）',
            target: true,
            from: ['gy'],
            filter: TG_MONSTER,
            min: 1,
            max: 1,
            modes: ['デッキに戻す', '手札に加える（自分フィールドに機械族の「ＴＧ」がいる時）'],
            then: (env, p, _, mode) =>
              mode === 1
                ? needMachineTG(env)
                  ? [fail(needMachineTG(env)!)]
                  : p.map((u) => toHand(u))
                : [...p.map((u) => move(u, { zone: 'deck' }, '効果でデッキに戻す')), shuffle],
          },
        ],
      },
    ],
  },

  // ＴＧ－オールクリア（①：フィールドの「ＴＧ」モンスターは機械族になる）
  '54573517': {
    effects: [
      { label: '発動', from: ['hand', 'spelltrap'], isCardActivation: true, steps: [] },
      {
        label: '② 通常召喚に加えて1度だけ、「ＴＧ」モンスターを召喚できる',
        from: ['spelltrap'],
        key: 'ＴＧ－オールクリア②',
        limit: 1,
        applied: true,
        condition: mainPhase,
        steps: [
          {
            op: 'do',
            then: () => [
              {
                type: 'GRANT_SUMMON',
                grant: {
                  source: 'ＴＧ－オールクリア',
                  extraSummon: true,
                  noTribute: false,
                  filter: TG_MONSTER,
                  thisTurnOnly: true,
                },
              },
            ],
          },
        ],
      },
      {
        label: '③ 手札・フィールドの「ＴＧ」を破壊し、カード名が異なる「ＴＧ」をデッキ・墓地から手札に加える',
        from: ['spelltrap'],
        key: 'ＴＧ－オールクリア③',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            prompt: '破壊する自分の手札・フィールドの「ＴＧ」モンスター',
            from: ['hand', 'monsters'],
            filter: TG_MONSTER,
            where: (env, u) => !onField(env, u) || env.state.cards[u].faceUp,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '効果で破壊')),
          },
          {
            op: 'pick',
            prompt: '手札に加える「ＴＧ」モンスター（デッキ・墓地。破壊したモンスターとカード名が異なる）',
            from: ['deck', 'gy'],
            filter: TG_MONSTER,
            where: (env, u) => env.def(u).name !== env.def(env.picks![0][0]).name,
            min: 1,
            max: 1,
            then: (env, p) => withShuffle(env, p, [toHand(p[0])]),
          },
        ],
      },
    ],
  },

  // ＴＧ１－ＥＭ１
  '76641981': { effects: [trapLogOnly('発動：相手のモンスターと自分の「ＴＧ」のコントロールを入れ替える（相手用）')] },

  // ＴＧ－クローズ（①②はいずれか1つ）
  '2339825': {
    effects: [
      trapLogOnly('① 機械族の「ＴＧ」がいる時、効果の発動を無効にし破壊（相手用）', 'ＴＧ－クローズ'),
      {
        label: '② Sモンスターが除外された場合：墓地のこのカードをセット（フィールドを離れると除外）',
        from: ['gy'],
        key: 'ＴＧ－クローズ',
        limit: 1,
        trigger: true,
        condition: (env) => {
          const s = env.state;
          const banished = [...s.banished, ...(s.opp?.banished ?? [])].some(
            (u) => env.def(u).frame === 'synchro' && s.cards[u].movedTurn === s.turn,
          );
          return banished ? hasFreeStz(env) : 'このターンにSモンスターが除外されていません';
        },
        steps: [
          {
            op: 'place',
            prompt: 'セットする魔法＆罠ゾーンを選択',
            zone: 'stz',
            then: (env, z) => [move(env.self, z, 'セット（フィールドを離れた場合に除外）', { faceUp: false })],
          },
        ],
      },
    ],
  },

  // 次元障壁
  '83326048': {
    effects: [trapLogOnly('発動：モンスターの種類を宣言し、このターンその種類の特殊召喚と効果を封じる（相手用）')],
  },

  // 激流葬
  '53582587': {
    effects: [
      {
        label: '発動：モンスターが召喚・特殊召喚された時、フィールドのモンスターを全て破壊',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: (env) => {
          const s = env.state;
          const fresh = [...ownMonsters(env), ...oppMonsters(env)].some((u) => {
            const inst = s.cards[u];
            return inst.enteredTurn === s.turn && inst.summonedEntry === inst.entryId && !missedTiming(s, u);
          });
          return fresh ? null : 'モンスターが召喚・反転召喚・特殊召喚された直後に発動できます';
        },
        steps: [
          { op: 'do', then: (env) => [...ownMonsters(env), ...oppMonsters(env)].map((u) => toGy(u, '効果で破壊')) },
        ],
      },
    ],
  },

  // ワン・フォー・ワン
  '2295440': {
    effects: [
      {
        label: '発動：手札のモンスターを墓地へ送り、手札・デッキからレベル1モンスターを特殊召喚',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：墓地へ送る手札のモンスター',
            from: ['hand'],
            filter: { kind: ['monster'] },
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u)),
          },
          {
            op: 'pick',
            prompt: '特殊召喚するレベル1モンスター（手札・デッキ）',
            from: ['hand', 'deck'],
            filter: { kind: ['monster'], minLevel: 1, maxLevel: 1 },
            min: 1,
            max: 1,
            zone: 'monster',
            then: (env, p, z) => withShuffle(env, p, [ss(p[0], z, 'ワン・フォー・ワン')]),
          },
        ],
      },
    ],
  },

  // ＴＧＸ３－ＤＸ２
  '3868277': {
    effects: [
      {
        label: '発動：墓地の「ＴＧ」モンスター3体をデッキに戻し、2枚ドロー',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        steps: returnAndDraw(3, TG_MONSTER, '「ＴＧ」モンスター'),
      },
    ],
  },

  // バトル・スタン・ソニック
  '93138457': {
    effects: [
      {
        label:
          '発動：相手モンスターの攻撃を無効にし、手札・デッキから「ＴＧ」かレベル4以下のチューナーを特殊召喚できる',
        from: ['hand', 'spelltrap'],
        isCardActivation: true,
        condition: (env) => {
          const b = env.state.battle;
          return b && b.byOpp && b.step === 'battle' && !missedTiming(env.state, b.attacker)
            ? null
            : '相手モンスターの攻撃宣言時に発動できます';
        },
        steps: [
          { op: 'do', then: () => [{ type: 'NEGATE_ATTACK', by: 'バトル・スタン・ソニック' }] },
          {
            op: 'pick',
            prompt: '特殊召喚する「ＴＧ」モンスターかレベル4以下のチューナー（手札・デッキ。出さなくてもよい）',
            from: ['hand', 'deck'],
            filter: { any: [TG_MONSTER, { kind: ['monster'], tuner: true, maxLevel: 4 }] },
            min: 0,
            max: 1,
            zone: 'monster',
            then: (env, p, z) =>
              withShuffle(
                env,
                p,
                p.map((u) => ss(u, z, 'バトル・スタン・ソニック')),
              ),
          },
        ],
      },
    ],
  },

  // ===== EXデッキ =====

  // ＴＧ ハイパー・ライブラリアン
  '90953320': {
    effects: [
      {
        label: '① このカードがいる状態でSモンスターがS召喚された場合：1枚ドロー',
        from: ['monster'],
        trigger: true,
        condition: (env) => (librarianPending(env) ? null : 'このカードがいる状態でS召喚されたSモンスターがいません'),
        steps: [
          {
            op: 'do',
            then: (env) => {
              const u = librarianPending(env)!;
              return [
                { type: 'ACTIVATE_EFFECT', uid: env.self, key: librarianKey(env, u), limit: 1, silent: true },
                draw(1),
              ];
            },
          },
        ],
      },
    ],
  },

  // ＴＧ レシプロ・ドラゴン・フライ
  '62560742': {
    materialCheck: oneNonTuner,
    effects: [
      {
        label: '① 他の「ＴＧ」Sモンスターを墓地へ送り、そのS素材の一組（全てSモンスター）を墓地から特殊召喚できる',
        from: ['monster'],
        key: 'ＴＧ レシプロ・ドラゴン・フライ①',
        limit: 1,
        perCard: true,
        targets: true,
        steps: [
          {
            op: 'pick',
            prompt: '墓地へ送る自分フィールドの他の「ＴＧ」Sモンスター（対象）',
            target: true,
            from: ['monsters'],
            where: (env, u) =>
              u !== env.self && env.state.cards[u].faceUp && isTG(env, u) && env.def(u).frame === 'synchro',
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '効果')),
          },
          {
            op: 'pick',
            prompt: '特殊召喚するS素材の一組（全部選ぶか、出さないなら選ばずに決定）',
            from: ['gy'],
            where: (env, u) => reciproSet(env).includes(u),
            range: (env) => [0, reciproSet(env).length],
            noSummonCheck: true,
            then: (env, p) => {
              const set = reciproSet(env);
              if (!p.length) return [];
              if (p.length !== set.length) return [fail('S素材の一組を全て選んでください')];
              const zones = freeMz(env.state);
              if (zones.length < p.length) return [fail('モンスターゾーンの空きが足りません')];
              return p.map((u, i) => ss(u, zones[i], 'ＴＧ レシプロ・ドラゴン・フライの効果'));
            },
          },
        ],
      },
    ],
  },

  // ＴＧ ワンダー・マジシャン
  '98558751': {
    materialCheck: nonTunersTG,
    effects: [
      {
        label: '① S召喚した場合：フィールドの魔法・罠1枚を破壊',
        from: ['monster'],
        key: 'ＴＧ ワンダー・マジシャン①',
        limit: 1,
        perCard: true,
        onSummon: true,
        trigger: true,
        targets: true,
        condition: (env) => {
          const s = env.state;
          const any = [...s.stz, s.fz, ...(s.opp?.stz ?? []), s.opp?.fz ?? null].some(Boolean);
          return synchroSummoned(env) ?? (any ? null : 'フィールドに魔法・罠カードがありません');
        },
        steps: [
          {
            op: 'pick',
            prompt: '破壊するフィールドの魔法・罠カード（対象）',
            target: true,
            from: ['spelltraps', 'oppSpelltraps'],
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toGy(u, '効果で破壊')),
          },
        ],
      },
      quickSynchro('②', 'ＴＧ ワンダー・マジシャン'),
      destroyedDraw('③', 'ＴＧ ワンダー・マジシャン'),
    ],
  },

  // ＴＧ パワー・グラディエイター（①は貫通）
  '24943456': {
    materialCheck: nonTunersTG,
    effects: [destroyedDraw('②', 'ＴＧ パワー・グラディエイター')],
  },

  // ＴＧ ブレード・ガンナー
  '51447164': {
    materialCheck: synchroOnly(1),
    effects: [
      logOnly('① このカードを対象とする相手の魔法・罠の発動時、手札を1枚捨てて効果を無効（相手用）', ['monster']),
      {
        label: '② 相手ターン：墓地の「ＴＧ」を除外し、このカードを除外（次のスタンバイフェイズに戻る）',
        from: ['monster'],
        key: 'ＴＧ ブレード・ガンナー②',
        limit: 1,
        perCard: true,
        speed: 2,
        condition: oppTurn,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：除外する自分の墓地の「ＴＧ」モンスター',
            from: ['gy'],
            filter: TG_MONSTER,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => move(u, { zone: 'banished' }, 'コスト')),
          },
          { op: 'do', then: (env) => [move(env.self, { zone: 'banished' }, 'ＴＧ ブレード・ガンナー②')] },
        ],
      },
      {
        label: '③ ②で除外された次のスタンバイフェイズ：除外状態のこのカードを特殊召喚',
        from: ['banished'],
        trigger: true,
        condition: (env) => {
          const inst = env.state.cards[env.self];
          return env.state.phase === 'SP' &&
            inst.movedReason === 'ＴＧ ブレード・ガンナー②' &&
            (inst.movedTurn ?? env.state.turn) < env.state.turn
            ? null
            : '②の効果で除外された次のスタンバイフェイズに発動します';
        },
        steps: [ssSelf('自身の効果')],
      },
    ],
  },

  // ＴＧ ハルバード・キャノン
  '97836203': {
    materialCheck: synchroOnly(2),
    effects: [
      logOnly(
        '① 召喚・反転召喚・特殊召喚する際に、それを無効にし破壊（相手用）',
        ['monster'],
        'ＴＧ ハルバード・キャノン①',
      ),
      {
        label: '② フィールドから墓地へ送られた時：墓地の「ＴＧ」モンスター1体を特殊召喚',
        from: ['gy'],
        key: 'ＴＧ ハルバード・キャノン②',
        limit: 1,
        perCard: true,
        trigger: true,
        targets: true,
        condition: sentFromFieldThisTurn,
        steps: ssTarget(
          '特殊召喚する自分の墓地の「ＴＧ」モンスター（対象）',
          ['gy'],
          (env, u) => u !== env.self && env.def(u).kind === 'monster' && isTG(env, u),
          'ＴＧ ハルバード・キャノンの効果',
        ),
      },
    ],
  },

  // クリスタルウィング・シンクロ・ドラゴン
  '50954680': {
    materialCheck: synchroCheck('チューナー以外の素材はSモンスターにしてください', (env, _t, o) =>
      o.every((u) => isSynchro(env, u)),
    ),
    effects: [
      logOnly(
        '① 他のモンスターの効果の発動を無効にし破壊、その攻撃力分アップ（相手用）',
        ['monster'],
        'クリスタルウィング①',
      ),
      logOnly('② レベル5以上の相手モンスターとのダメージ計算時、その攻撃力分アップ（相手用）', ['monster']),
    ],
  },

  // ＴＧ スター・ガーディアン
  '99937842': {
    materialCheck: nonTunersTG,
    effects: [
      {
        label: '① 特殊召喚した場合：墓地の「ＴＧ」モンスター1体を手札に加える',
        from: ['monster'],
        key: 'ＴＧ スター・ガーディアン①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: (env) =>
          env.state.cards[env.self].summonType && env.state.cards[env.self].summonType !== 'normal'
            ? null
            : '特殊召喚した時に発動できます',
        steps: [
          {
            op: 'pick',
            prompt: '手札に加える自分の墓地の「ＴＧ」モンスター（対象）',
            target: true,
            from: ['gy'],
            filter: TG_MONSTER,
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => toHand(u)),
          },
        ],
      },
      {
        label: '② 手札から「ＴＧ」モンスター1体を特殊召喚',
        from: ['monster'],
        key: 'ＴＧ スター・ガーディアン②',
        limit: 1,
        condition: mainPhase,
        steps: [
          {
            op: 'pick',
            prompt: '手札から特殊召喚する「ＴＧ」モンスター',
            from: ['hand'],
            filter: TG_MONSTER,
            min: 1,
            max: 1,
            zone: 'monster',
            then: (_, p, z) => [ss(p[0], z, 'ＴＧ スター・ガーディアンの効果')],
          },
        ],
      },
      quickSynchro('③', 'ＴＧ スター・ガーディアン'),
    ],
  },

  // ＴＧ トライデント・ランチャー（②：リンク先の「ＴＧ」Sモンスターを相手は効果の対象にできない）
  '50750868': {
    materialCheck: (env, materials, method) => {
      if (method !== 'link') return null;
      const effects = materials.every((u) => {
        const d = env.def(u);
        return d.kind === 'monster' && d.frame !== 'normal' && d.frame !== 'token';
      });
      const tgTuner = materials.some((u) => env.def(u).tuner && isTG(env, u));
      return effects && tgTuner ? null : '「ＴＧ」チューナーを含む効果モンスター2体以上が必要です';
    },
    effects: [
      {
        label: '① L召喚した場合：手札・デッキ・墓地から「ＴＧ」を1体ずつ、リンク先に守備表示で特殊召喚',
        from: ['monster'],
        key: 'ＴＧ トライデント・ランチャー①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: (env) => (env.state.cards[env.self].summonType === 'link' ? null : 'L召喚した時に発動できます'),
        steps: [
          {
            op: 'do',
            cost: true,
            then: () => [
              { type: 'EXTRA_LOCK', source: 'ＴＧ トライデント・ランチャー', filter: TG_MONSTER, all: true },
            ],
          },
          ...(['hand', 'deck', 'gy'] as const).map(
            (from): Step => ({
              op: 'pick',
              prompt: `リンク先に守備表示で特殊召喚する「ＴＧ」モンスター（${{ hand: '手札', deck: 'デッキ', gy: '墓地' }[from]}から1体・出さなくてもよい）`,
              from: [from],
              filter: TG_MONSTER,
              min: 0,
              max: 1,
              zone: 'monster',
              zoneFilter: tridentZone,
              then: (env, p, z) =>
                withShuffle(
                  env,
                  p,
                  p.map((u) => ss(u, z, 'ＴＧ トライデント・ランチャーの効果', 'def')),
                ),
            }),
          ),
        ],
      },
    ],
  },

  // シューティング・スター・ドラゴン・ＴＧ－ＥＸ
  '63180841': {
    materialCheck: synchroOnly(1),
    effects: [
      logOnly('① 自分のモンスターを対象とするモンスター効果の発動を無効にし破壊（相手用）', ['monster']),
      logOnly(
        '② 相手モンスターの攻撃宣言時、その攻撃を無効（相手用）',
        ['monster'],
        'シューティング・スター・ドラゴン・ＴＧ－ＥＸ②',
      ),
      {
        label: '③ 相手ターン：自分のSモンスター2体をリリースし、墓地のこのカードを特殊召喚',
        from: ['gy'],
        key: 'シューティング・スター・ドラゴン・ＴＧ－ＥＸ③',
        limit: 1,
        speed: 2,
        condition: oppTurn,
        steps: [
          {
            op: 'pick',
            cost: true,
            prompt: 'コスト：リリースする自分フィールドのSモンスター2体',
            from: ['monsters'],
            where: (env, u) => env.state.cards[u].faceUp && isSynchro(env, u),
            min: 2,
            max: 2,
            then: (_, p) => p.map((u) => toGy(u, 'リリース')),
          },
          ssSelf('自身の効果'),
        ],
      },
    ],
  },

  // ＴＧ マイティ・ストライカー
  '32480825': {
    materialCheck: oneNonTuner,
    effects: [
      {
        label: '① S召喚した場合：デッキから「ＴＧ」魔法・罠カードを手札に加える',
        from: ['monster'],
        key: 'ＴＧ マイティ・ストライカー①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: synchroSummoned,
        steps: [search('デッキから手札に加える「ＴＧ」魔法・罠カード', { kind: ['spell', 'trap'], archetype: TG })],
      },
      quickSynchro('②', 'ＴＧ マイティ・ストライカー', 'ＴＧ マイティ・ストライカー②'),
      {
        label: '③ モンスターゾーンから墓地へ送られた場合：デッキから「ＴＧ」カードを墓地へ送る',
        from: ['gy'],
        key: 'ＴＧ マイティ・ストライカー③',
        limit: 1,
        trigger: true,
        condition: sentFromFieldThisTurn,
        steps: [
          {
            op: 'pick',
            prompt: 'デッキから墓地へ送る「ＴＧ」カード',
            from: ['deck'],
            filter: { archetype: TG },
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

  // ＴＧ オーバー・ドラグナー
  '68989420': {
    effects: [
      {
        label: '① S召喚した場合：墓地の「ＴＧ」モンスターを好きな数だけ守備表示で特殊召喚',
        from: ['monster'],
        key: 'ＴＧ オーバー・ドラグナー①',
        limit: 1,
        onSummon: true,
        trigger: true,
        condition: synchroSummoned,
        steps: [
          {
            op: 'do',
            cost: true,
            then: () => [{ type: 'EXTRA_LOCK', source: 'ＴＧ オーバー・ドラグナー', filter: TG_MONSTER, all: true }],
          },
          {
            op: 'pick',
            prompt: '守備表示で特殊召喚する自分の墓地の「ＴＧ」モンスター（好きな数）',
            from: ['gy'],
            filter: TG_MONSTER,
            range: (env) => [1, Math.max(1, freeMz(env.state).length)],
            then: (env, p) => {
              const zones = freeMz(env.state);
              if (zones.length < p.length) return [fail('モンスターゾーンの空きが足りません')];
              return p.map((u, i) => ss(u, zones[i], 'ＴＧ オーバー・ドラグナーの効果', 'def'));
            },
          },
        ],
      },
      destroyedDraw('②', 'ＴＧ オーバー・ドラグナー'),
    ],
  },

  // ＴＧ グレイヴ・ブラスター
  '95973569': {
    materialCheck: synchroOnly(2),
    effects: [
      {
        label:
          '① EXデッキから特殊召喚されたフィールドのモンスター1体を除外（S素材にしたチューナー以外のSモンスターの数まで）',
        from: ['monster'],
        key: 'ＴＧ グレイヴ・ブラスター①',
        limit: 99,
        speed: 2,
        targets: true,
        condition: (env) => {
          const used = env.state.effectUses['ＴＧ グレイヴ・ブラスター①'] ?? 0;
          return used < graveUses(env) ? null : `このターンはもう使えません（${graveUses(env)}回まで）`;
        },
        steps: [
          {
            op: 'pick',
            prompt: '除外するEXデッキから特殊召喚されたモンスター（対象）',
            target: true,
            from: ['monsters', 'oppMonsters'],
            where: (env, u) =>
              env.state.cards[u].faceUp &&
              (env.state.cards[u].opp
                ? ['fusion', 'synchro', 'xyz', 'link'].includes(env.def(u).frame ?? '')
                : env.state.cards[u].movedFrom === 'extra'),
            min: 1,
            max: 1,
            then: (_, p) => p.map((u) => move(u, { zone: 'banished' }, '効果で除外')),
          },
        ],
      },
      {
        label: '② モンスターが表側で除外された場合：その1体を召喚条件を無視して特殊召喚',
        from: ['monster'],
        key: 'ＴＧ グレイヴ・ブラスター②',
        limit: 1,
        trigger: true,
        targets: true,
        condition: (env) => (graveBanished(env).length ? null : 'このターンに表側で除外されたモンスターがいません'),
        steps: [
          {
            op: 'pick',
            prompt: '特殊召喚する除外されたモンスター（対象）',
            target: true,
            from: ['banished'],
            where: (env, u) => graveBanished(env).includes(u),
            min: 1,
            max: 1,
            then: () => [],
          },
          {
            op: 'place',
            prompt: '対象のモンスターを出すゾーンを選択',
            zone: 'monster',
            then: (env, z) => [
              {
                type: 'SPECIAL_SUMMON',
                uid: env.picks![0][0],
                to: z as MonsterLocation,
                note: '召喚条件を無視',
                ignoreConditions: true,
              },
            ],
          },
        ],
      },
    ],
  },
};

// ===== カードごとの判定 =====

/** ＴＧ ハイパー・ライブラリアン：このカードが出た後にS召喚されたSモンスターのうち、まだドローしていないもの */
function librarianKey(env: Env, u: string): string {
  return `ＴＧ ハイパー・ライブラリアン:${env.self}:${u}:${env.state.cards[u].entryId}`;
}
function librarianPending(env: Env): string | undefined {
  const s = env.state;
  const self = s.cards[env.self];
  if (!self.faceUp || !onField(env, env.self)) return undefined;
  return [...ownMonsters(env), ...oppMonsters(env)].find((u) => {
    const inst = s.cards[u];
    return (
      u !== env.self &&
      inst.summonType === 'synchro' &&
      inst.enteredTurn === s.turn &&
      inst.entryId > self.entryId &&
      !s.effectUses[librarianKey(env, u)]
    );
  });
}

/** ＴＧ レシプロ・ドラゴン・フライ：墓地へ送ったSモンスターのS素材の一組（全てSモンスターで墓地に揃っていれば） */
function reciproSet(env: Env): string[] {
  const target = env.picks?.[0]?.[0];
  const mats = target ? (env.state.cards[target].materials ?? []) : [];
  const ok = mats.length > 0 && mats.every((u) => env.loc(u)?.zone === 'gy' && env.def(u).frame === 'synchro');
  return ok ? mats : [];
}

/** ＴＧ グレイヴ・ブラスター①を使える回数：S素材にしたチューナー以外のSモンスターの数 */
function graveUses(env: Env): number {
  const mats = env.state.cards[env.self].materials ?? [];
  const synchros = mats.filter((u) => env.def(u).frame === 'synchro');
  return Math.max(0, synchros.length - 1);
}

/** ＴＧ グレイヴ・ブラスター②：このターンに表側で除外されたモンスター */
function graveBanished(env: Env): string[] {
  const s = env.state;
  return s.banished.filter(
    (u) => s.cards[u].faceUp && s.cards[u].movedTurn === s.turn && env.def(u).kind === 'monster',
  );
}
