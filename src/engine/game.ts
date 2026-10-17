import { mulberry32, shuffle } from './rng';
import { canMakeLinkRating, levelOf, linkedMainZones, linkMaterialOptions, tributesRequired } from './rules';
import { type CardFilter, hasToonWorld, isToonMonster, matchesFilter } from './filters';
import type { CardScript, Env } from './scripts';
import type {
  Attribute,
  BattlePosition,
  CardDef,
  CardInstance,
  DeckList,
  GameOptions,
  GameState,
  Location,
  LogEntry,
  Phase,
  PileZone,
  SummonGrant,
} from './types';
import { isExtraDeckCard, PHASE_LABEL, PHASE_ORDER } from './types';

export type MonsterLocation = { zone: 'mz'; index: number } | { zone: 'emz'; index: number };

export type SummonMethod = 'fusion' | 'synchro' | 'xyz' | 'link' | 'ritual';

export type Action =
  | { type: 'NEXT_PHASE'; to?: Phase }
  | { type: 'END_TURN' }
  | { type: 'DRAW'; count?: number }
  | {
      type: 'NORMAL_SUMMON';
      uid: string;
      index: number;
      tributes?: string[];
      set?: boolean;
      /** 追加の召喚権を使う（summonGrants の番号） */
      grant?: number;
      /** リリースなし召喚の効果を使う（summonGrants の番号） */
      noTributeGrant?: number;
    }
  | { type: 'FLIP_SUMMON'; uid: string }
  | {
      type: 'SPECIAL_SUMMON';
      uid: string;
      to: MonsterLocation;
      position?: BattlePosition;
      faceDown?: boolean;
      note?: string;
    }
  | {
      type: 'PROCEDURE_SUMMON';
      method: SummonMethod;
      uid: string;
      materials: string[];
      to: MonsterLocation;
      position?: BattlePosition;
      /** 融合・儀式素材の行き先（既定は墓地） */
      materialsTo?: 'gy' | 'banished';
    }
  | {
      /** カード固有の召喚条件による特殊召喚 */
      type: 'PROC_SUMMON';
      uid: string;
      proc: number;
      materials: string[];
      to: MonsterLocation;
      position?: BattlePosition;
    }
  | { type: 'SET_SPELL_TRAP'; uid: string; index?: number }
  | { type: 'ACTIVATE_CARD'; uid: string; index?: number }
  | { type: 'RESOLVE'; uid: string }
  | { type: 'ACTIVATE_EFFECT'; uid: string; label?: string; key?: string; limit?: number; silent?: boolean }
  | {
      type: 'MOVE';
      uid: string;
      to: Location;
      faceUp?: boolean;
      position?: BattlePosition;
      toBottom?: boolean;
      reason?: string;
    }
  | { type: 'CHANGE_POSITION'; uid: string }
  | { type: 'ATTACK'; uid: string }
  | { type: 'SHUFFLE_DECK' }
  | { type: 'ATTACH'; uid: string; target: string }
  | { type: 'DETACH'; target: string; uid: string }
  | {
      type: 'CREATE_TOKEN';
      name: string;
      level: number;
      atk: number;
      def: number;
      attribute?: Attribute;
      race?: string;
      to: MonsterLocation;
      position?: BattlePosition;
    }
  | { type: 'MILL'; count: number }
  | { type: 'CHANGE_LP'; delta: number }
  | { type: 'GRANT_SUMMON'; grant: SummonGrant }
  | { type: 'SET_COUNTERS'; uid: string; value: number }
  | { type: 'DOUBLE_ATTACK'; uid: string }
  /** 効果をチェーンに積む（コストは支払い済み） */
  | { type: 'CHAIN_PUSH'; uid: string; effect: number; stepStart: number; speed: number; label: string }
  /** 一番上のチェーンの解決が終わった */
  | { type: 'CHAIN_POP' }
  /** 複数の操作をまとめて1手として行う（効果処理など） */
  | { type: 'BATCH'; label?: string; actions: Action[] };

export interface Ctx {
  db: Record<string, CardDef>;
  options: GameOptions;
  /** カード固有の召喚条件・効果（カードID → スクリプト） */
  scripts?: Record<string, CardScript>;
}

export type ActionResult = { ok: true; state: GameState } | { ok: false; error: string };

class RuleError extends Error {}

function fail(msg: string): never {
  throw new RuleError(msg);
}

// ===== 初期化 =====

export function createGame(
  deck: DeckList,
  ctx: Ctx,
  seed: number,
  /** 初手に必ず含めるカードID（ルート練習用の初手指定） */
  fixedHand: string[] = [],
  /** 初手の枚数。6枚なら後攻（1ターン目のドロー後）として始める */
  handSize: 5 | 6 = 5,
): GameState {
  const cards: Record<string, CardInstance> = {};
  let nextUid = 1;
  const make = (defId: string): string => {
    if (!ctx.db[defId]) throw new Error(`カードが見つかりません: ${defId}`);
    const uid = `c${nextUid++}`;
    cards[uid] = newInstance(uid, defId);
    return uid;
  };
  const mainUids = deck.main.map(make);
  const extraUids = deck.extra.map(make);

  const rand = mulberry32(seed);
  let shuffled = shuffle(mainUids, rand);
  const hand: string[] = [];
  for (const defId of fixedHand) {
    const i = shuffled.findIndex((u) => cards[u].defId === defId);
    if (i < 0) throw new Error(`初手指定のカードがデッキにありません: ${ctx.db[defId]?.name ?? defId}`);
    hand.push(shuffled[i]);
    shuffled = [...shuffled.slice(0, i), ...shuffled.slice(i + 1)];
  }
  if (fixedHand.length > handSize) throw new Error(`初手は${handSize}枚までです`);
  while (hand.length < handSize && shuffled.length > 0) hand.push(shuffled.shift()!);
  const second = handSize === 6;

  const state: GameState = {
    seed,
    cards,
    tokenDefs: {},
    deck: shuffled,
    hand,
    extra: extraUids,
    gy: [],
    banished: [],
    mz: [null, null, null, null, null],
    emz: [null, null],
    stz: [null, null, null, null, null],
    fz: null,
    // 後攻は「2ターン目」として扱う（バトルフェイズを行える）
    turn: second ? 2 : 1,
    phase: 'M1',
    lp: 8000,
    opponentLp: 8000,
    normalSummonUsed: false,
    effectUses: {},
    status: 'playing',
    log: [],
    nextUid,
    shuffleCount: 0,
    summonGrants: [],
    spellActivatedThisTurn: false,
    chain: [],
  };
  if (second) {
    log(state, `デュエル開始（後攻・シード ${seed}）。初手5枚＋ドロー1枚の6枚から始めます。`, 'info');
  } else {
    log(state, `デュエル開始（先攻・シード ${seed}）。初手5枚をドロー。`, 'info');
    log(state, '先攻1ターン目はドローフェイズにドローせず、バトルフェイズも行えません。', 'info');
  }
  return state;
}

function newInstance(uid: string, defId: string): CardInstance {
  return {
    uid,
    defId,
    faceUp: false,
    position: 'atk',
    overlay: [],
    counters: 0,
    enteredTurn: null,
    positionChangedTurn: null,
    attackedTurn: null,
    pendingResolve: false,
    faceUpInExtra: false,
    attackCount: 0,
    doubleAttackTurn: null,
    entryId: 0,
    summonedEntry: null,
  };
}

/** 召喚・特殊召喚した（「召喚した時」の効果の判定に使う。効果で戻っただけのカードは含まない） */
function markSummoned(state: GameState, uid: string) {
  const inst = state.cards[uid];
  inst.enteredTurn = state.turn;
  inst.summonedEntry = inst.entryId;
}

// ===== 参照ヘルパー =====

export function getDef(state: GameState, ctx: Ctx, uid: string): CardDef {
  const inst = state.cards[uid];
  const def = state.tokenDefs[inst.defId] ?? ctx.db[inst.defId];
  if (!def) throw new Error(`カード定義がありません: ${inst.defId}`);
  return def;
}

export function makeEnv(state: GameState, ctx: Ctx, self: string): Env {
  const def = (uid: string) => getDef(state, ctx, uid);
  const toonWorld = hasToonWorld(state, def);
  return {
    state,
    ctx,
    self,
    def,
    loc: (uid) => findLocation(state, uid),
    toonWorld,
    isToon: (uid) => isToonMonster(def(uid), toonWorldFor(uid)),
    matches: (uid, filter) => matchesFilter(def(uid), filter, toonWorldFor(uid)),
  };

  /** 「トゥーン・ワールドがある限りトゥーンとして扱う」はフィールドにいる間だけ適用する */
  function toonWorldFor(uid: string): boolean {
    return toonWorld && isMonsterZone(findLocation(state, uid));
  }
}

export function findLocation(state: GameState, uid: string): Location | null {
  for (const z of ['deck', 'hand', 'extra', 'gy', 'banished'] as PileZone[]) {
    if (state[z].includes(uid)) return { zone: z };
  }
  let i = state.mz.indexOf(uid);
  if (i >= 0) return { zone: 'mz', index: i };
  i = state.emz.indexOf(uid);
  if (i >= 0) return { zone: 'emz', index: i };
  i = state.stz.indexOf(uid);
  if (i >= 0) return { zone: 'stz', index: i };
  if (state.fz === uid) return { zone: 'fz' };
  return null;
}

export function isOnField(loc: Location | null): boolean {
  return !!loc && (loc.zone === 'mz' || loc.zone === 'emz' || loc.zone === 'stz' || loc.zone === 'fz');
}

export function isMonsterZone(loc: Location | null): loc is MonsterLocation {
  return !!loc && (loc.zone === 'mz' || loc.zone === 'emz');
}

export function fieldMonsters(state: GameState): string[] {
  return [...state.mz, ...state.emz].filter((u): u is string => !!u);
}

export const ZONE_LABEL: Record<Location['zone'], string> = {
  deck: 'デッキ',
  hand: '手札',
  extra: 'エクストラデッキ',
  gy: '墓地',
  banished: '除外',
  mz: 'モンスターゾーン',
  emz: 'EXモンスターゾーン',
  stz: '魔法＆罠ゾーン',
  fz: 'フィールドゾーン',
};

function locLabel(loc: Location): string {
  if (loc.zone === 'mz' || loc.zone === 'stz') return `${ZONE_LABEL[loc.zone]}${loc.index + 1}`;
  if (loc.zone === 'emz') return `${ZONE_LABEL.emz}(${loc.index === 0 ? '左' : '右'})`;
  return ZONE_LABEL[loc.zone];
}

function log(state: GameState, text: string, kind: LogEntry['kind'] = 'move') {
  state.log.push({ turn: state.turn, phase: state.phase, text, kind });
}

// ===== カードの移動（全ての移動はここを通る） =====

function detach(state: GameState, uid: string) {
  const loc = findLocation(state, uid);
  if (!loc) {
    // エクシーズ素材として重なっている
    for (const inst of Object.values(state.cards)) {
      const i = inst.overlay.indexOf(uid);
      if (i >= 0) inst.overlay.splice(i, 1);
    }
    return;
  }
  switch (loc.zone) {
    case 'mz':
    case 'emz':
    case 'stz':
      state[loc.zone][loc.index] = null;
      break;
    case 'fz':
      state.fz = null;
      break;
    default:
      state[loc.zone] = state[loc.zone].filter((u) => u !== uid);
  }
}

function resetInstance(inst: CardInstance) {
  inst.position = 'atk';
  inst.counters = 0;
  inst.enteredTurn = null;
  inst.positionChangedTurn = null;
  inst.attackedTurn = null;
  inst.pendingResolve = false;
  inst.faceUpInExtra = false;
  inst.attackCount = 0;
  inst.doubleAttackTurn = null;
  inst.summonedEntry = null;
}

interface PlaceOpts {
  faceUp?: boolean;
  position?: BattlePosition;
  toBottom?: boolean;
}

/**
 * カードを指定の場所へ移す。ゲームのルールによる移動先の変化もここで処理する。
 * - フィールドを離れるモンスターのエクシーズ素材は墓地へ
 * - トークンはフィールド以外へ移動すると消滅
 * - EXデッキのモンスターは手札・デッキではなくEXデッキへ戻る
 * - フィールドから墓地へ送られるPモンスターはEXデッキに表側で加わる
 */
function moveCard(state: GameState, ctx: Ctx, uid: string, to: Location, opts: PlaceOpts = {}): Location | null {
  const inst = state.cards[uid];
  const def = getDef(state, ctx, uid);
  const from = findLocation(state, uid);
  const leavingField = isOnField(from) && !isOnField(to);

  if (from && isMonsterZone(from) && !isMonsterZone(to)) {
    for (const mat of [...inst.overlay]) {
      inst.overlay = inst.overlay.filter((u) => u !== mat);
      placeRaw(state, mat, { zone: 'gy' }, {});
      state.cards[mat].faceUp = true;
    }
  }

  detach(state, uid);

  if (def.frame === 'token' && !isOnField(to)) {
    delete state.cards[uid];
    log(state, `${def.name} は消滅した`, 'move');
    return null;
  }

  let dest = to;
  if (isExtraDeckCard(def) && (to.zone === 'hand' || to.zone === 'deck')) dest = { zone: 'extra' };
  const pendulumToExtra = def.pendulumScale !== undefined && isOnField(from) && to.zone === 'gy';
  if (pendulumToExtra) dest = { zone: 'extra' };

  if (leavingField || !isOnField(to)) resetInstance(inst);
  if (pendulumToExtra) inst.faceUpInExtra = true;
  placeRaw(state, uid, dest, opts);
  if (isOnField(dest) && !isOnField(from)) inst.entryId = state.nextUid++;
  return dest;
}

function placeRaw(state: GameState, uid: string, to: Location, opts: PlaceOpts) {
  const inst = state.cards[uid];
  switch (to.zone) {
    case 'mz':
    case 'emz':
    case 'stz':
      state[to.zone][to.index] = uid;
      inst.faceUp = opts.faceUp ?? true;
      inst.position = opts.position ?? inst.position;
      break;
    case 'fz':
      state.fz = uid;
      inst.faceUp = opts.faceUp ?? true;
      break;
    case 'deck':
      inst.faceUp = false;
      if (opts.toBottom) state.deck.push(uid);
      else state.deck.unshift(uid);
      break;
    case 'hand':
      inst.faceUp = false;
      state.hand.push(uid);
      break;
    case 'extra':
      inst.faceUp = inst.faceUpInExtra;
      state.extra.push(uid);
      break;
    case 'gy':
    case 'banished':
      inst.faceUp = opts.faceUp ?? true;
      state[to.zone].push(uid);
      break;
  }
}

// ===== ルールチェック =====

function requireMainPhase(state: GameState, ctx: Ctx, what: string) {
  if (ctx.options.strict && state.phase !== 'M1' && state.phase !== 'M2') {
    fail(`${what}はメインフェイズにのみ行えます`);
  }
}

function checkMonsterZoneFree(state: GameState, ctx: Ctx, to: MonsterLocation, ignore: string[] = []) {
  if (to.index < 0 || to.index >= (to.zone === 'mz' ? 5 : 2)) fail('ゾーン番号が不正です');
  const occupant = state[to.zone][to.index];
  if (occupant && !ignore.includes(occupant)) fail(`${locLabel(to)}は使用中です`);
  if (to.zone === 'emz' && ctx.options.strict) {
    const other = state.emz[1 - to.index];
    if (other && !ignore.includes(other)) fail('EXモンスターゾーンは1つしか使用できません');
  }
}

/** EXデッキから特殊召喚するモンスターの置き場所（マスタールール2020年4月改訂） */
function checkExtraDeckPlacement(state: GameState, ctx: Ctx, uid: string, to: MonsterLocation, from: Location | null) {
  if (!ctx.options.strict) return;
  if (from?.zone !== 'extra') {
    if (to.zone === 'emz') fail('EXモンスターゾーンにはEXデッキから特殊召喚するモンスターしか出せません');
    return;
  }
  const def = getDef(state, ctx, uid);
  const inst = state.cards[uid];
  const needsLinkedZone = def.frame === 'link' || (def.pendulumScale !== undefined && inst.faceUpInExtra);
  if (!needsLinkedZone || to.zone === 'emz') return;
  const linked = linkedMainZones(state, (u) => getDef(state, ctx, u));
  if (!linked.has(to.index)) {
    fail(`${def.name}はEXモンスターゾーンかリンク先のメインモンスターゾーンにしか出せません`);
  }
}

function requireFaceUpFieldMonsters(state: GameState, ctx: Ctx, uids: string[], what: string) {
  for (const u of uids) {
    const loc = findLocation(state, u);
    if (!isMonsterZone(loc)) fail(`${what}はフィールドのモンスターから選んでください`);
    if (!state.cards[u].faceUp) fail(`裏側表示のモンスターは${what}にできません`);
  }
  if (new Set(uids).size !== uids.length) fail('同じカードを重複して選んでいます');
  void ctx;
}

function sendMaterials(state: GameState, ctx: Ctx, uids: string[], dest: 'gy' | 'banished') {
  for (const u of uids) moveCard(state, ctx, u, { zone: dest });
}

function checkSummonable(state: GameState, ctx: Ctx, uid: string) {
  const def = getDef(state, ctx, uid);
  if (def.kind !== 'monster') fail(`${def.name}はモンスターではありません`);
}

// ===== アクション =====

export function applyAction(prev: GameState, action: Action, ctx: Ctx): ActionResult {
  const state = structuredClone(prev);
  try {
    if (state.status !== 'playing' && ctx.options.strict && action.type !== 'MOVE') {
      fail('デュエルは終了しています');
    }
    reduce(state, action, ctx);
    if (state.lp <= 0 && state.status === 'playing') {
      state.status = 'lost';
      state.statusReason = 'LPが0になった';
      log(state, 'LPが0になりました', 'warn');
    }
    return { ok: true, state };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message };
    throw e;
  }
}

function name(state: GameState, ctx: Ctx, uid: string) {
  return getDef(state, ctx, uid).name;
}

function drawCards(state: GameState, count: number) {
  for (let i = 0; i < count; i++) {
    const uid = state.deck.shift();
    if (!uid) {
      state.status = 'lost';
      state.statusReason = 'デッキからドローできなかった';
      log(state, 'デッキが0枚のためドローできません（敗北）', 'warn');
      return;
    }
    state.hand.push(uid);
  }
}

/** チェーンを解決するまで行えない操作 */
const BLOCKED_DURING_CHAIN = new Set<Action['type']>([
  'NEXT_PHASE',
  'END_TURN',
  'NORMAL_SUMMON',
  'FLIP_SUMMON',
  'PROC_SUMMON',
  'PROCEDURE_SUMMON',
  'SET_SPELL_TRAP',
  'CHANGE_POSITION',
  'ATTACK',
]);

function reduce(state: GameState, action: Action, ctx: Ctx): void {
  const strict = ctx.options.strict;
  // 古い保存データには chain が無い
  state.chain ??= [];
  if (strict && state.chain.length && BLOCKED_DURING_CHAIN.has(action.type)) {
    fail('チェーンを解決してから行ってください');
  }
  switch (action.type) {
    case 'NEXT_PHASE': {
      const cur = PHASE_ORDER.indexOf(state.phase);
      let next: Phase | undefined = action.to ?? PHASE_ORDER[cur + 1];
      if (!next) return reduce(state, { type: 'END_TURN' }, ctx);
      if (PHASE_ORDER.indexOf(next) <= cur) fail('前のフェイズには戻れません');
      // 先攻1ターン目はバトルフェイズを行えない（M2もBPを経由しないので行えない）
      if (state.turn === 1 && (next === 'BP' || next === 'M2')) next = 'EP';
      // BPを行わない場合、M2は行えない
      if (next === 'M2' && state.phase !== 'BP') next = 'EP';
      state.phase = next;
      log(state, `${PHASE_LABEL[next]}へ移行`, 'info');
      return;
    }
    case 'END_TURN': {
      if (strict && state.hand.length > 6) {
        fail(`手札が${state.hand.length}枚です。エンドフェイズに6枚になるよう捨ててください`);
      }
      for (const u of [...state.stz, state.fz]) {
        if (u && state.cards[u].pendingResolve) fail(`${name(state, ctx, u)}の解決が終わっていません`);
      }
      state.turn += 1;
      state.phase = 'DP';
      state.normalSummonUsed = false;
      state.effectUses = {};
      state.spellActivatedThisTurn = false;
      state.summonGrants = state.summonGrants.filter((g) => !g.thisTurnOnly);
      log(state, `ターン${state.turn}開始（ドローフェイズ）`, 'info');
      drawCards(state, 1);
      return;
    }
    case 'DRAW': {
      const n = action.count ?? 1;
      drawCards(state, n);
      log(state, `${n}枚ドロー`, 'move');
      return;
    }
    case 'NORMAL_SUMMON': {
      const { uid, index } = action;
      const tributes = action.tributes ?? [];
      const def = getDef(state, ctx, uid);
      checkSummonable(state, ctx, uid);
      requireMainPhase(state, ctx, '通常召喚');
      const toonWorld = hasToonWorld(state, (u) => getDef(state, ctx, u));
      const grant = action.grant !== undefined ? state.summonGrants[action.grant] : undefined;
      const noTrib = action.noTributeGrant !== undefined ? state.summonGrants[action.noTributeGrant] : undefined;
      if (action.grant !== undefined && !grant?.extraSummon) fail('使える追加の召喚権がありません');
      if (action.noTributeGrant !== undefined && !noTrib?.noTribute) fail('リリースなしで召喚できる効果がありません');
      if (strict) {
        if (!state.hand.includes(uid)) fail('通常召喚は手札のモンスターのみ行えます');
        if (!grant && state.normalSummonUsed) fail('通常召喚（セット）はターンに1度までです');
        if (grant && action.set) fail('追加の召喚権ではセットできません');
        if (grant && !matchesFilter(def, grant.filter, toonWorld))
          fail(`${def.name}は「${grant.source}」の効果で召喚できません`);
        if (noTrib && !matchesFilter(def, noTrib.filter, toonWorld))
          fail(`${def.name}は「${noTrib.source}」の効果の対象外です`);
        if (isExtraDeckCard(def) || def.frame === 'ritual' || def.cannotNormalSummon) {
          fail(`${def.name}は通常召喚できません`);
        }
        const need = noTrib ? 0 : tributesRequired(def.level ?? 0);
        if (tributes.length !== need) fail(`${def.name}の召喚にはリリースが${need}体必要です`);
        for (const t of tributes)
          if (!isMonsterZone(findLocation(state, t))) fail('リリースは自分フィールドのモンスターから選んでください');
      }
      // 使った召喚権・効果を消費（番号がずれないよう大きい方から）
      for (const i of [action.grant, action.noTributeGrant]
        .filter((x): x is number => x !== undefined)
        .sort((a, b) => b - a)) {
        state.summonGrants.splice(i, 1);
      }
      checkMonsterZoneFree(state, ctx, { zone: 'mz', index }, tributes);
      const tributeNames = tributes.map((t) => name(state, ctx, t));
      sendMaterials(state, ctx, tributes, 'gy');
      moveCard(
        state,
        ctx,
        uid,
        { zone: 'mz', index },
        {
          faceUp: !action.set,
          position: action.set ? 'def' : 'atk',
        },
      );
      markSummoned(state, uid);
      if (!grant) state.normalSummonUsed = true;
      const how = grant
        ? `${tributes.length ? `${tributeNames.join('・')}をリリースし、` : ''}${grant.source}の効果で`
        : noTrib
          ? `${noTrib.source}の効果でリリースなしで`
          : tributes.length
            ? `${tributeNames.join('・')}をリリースしてアドバンス`
            : '通常';
      log(state, action.set ? `${def.name}を${how}セット` : `${def.name}を${how}召喚`, 'summon');
      return;
    }
    case 'FLIP_SUMMON': {
      const inst = state.cards[action.uid];
      requireMainPhase(state, ctx, '反転召喚');
      if (!isMonsterZone(findLocation(state, action.uid)) || inst.faceUp)
        fail('裏側守備表示のモンスターのみ反転召喚できます');
      if (strict && inst.enteredTurn === state.turn) fail('セットしたターンには反転召喚できません');
      inst.faceUp = true;
      inst.position = 'atk';
      inst.positionChangedTurn = state.turn;
      inst.summonedEntry = inst.entryId;
      log(state, `${name(state, ctx, action.uid)}を反転召喚`, 'summon');
      return;
    }
    case 'SPECIAL_SUMMON': {
      const { uid, to } = action;
      checkSummonable(state, ctx, uid);
      const from = findLocation(state, uid);
      if (isMonsterZone(from)) fail('既にフィールドにいます');
      checkMonsterZoneFree(state, ctx, to);
      checkExtraDeckPlacement(state, ctx, uid, to, from);
      const faceDown = !!action.faceDown;
      moveCard(state, ctx, uid, to, {
        faceUp: !faceDown,
        position: faceDown ? 'def' : (action.position ?? 'atk'),
      });
      markSummoned(state, uid);
      const pos = faceDown ? '裏側守備表示' : action.position === 'def' ? '守備表示' : '攻撃表示';
      log(
        state,
        `${name(state, ctx, uid)}を${from ? ZONE_LABEL[from.zone] : ''}から${pos}で特殊召喚${action.note ? `（${action.note}）` : ''}`,
        'summon',
      );
      return;
    }
    case 'PROCEDURE_SUMMON':
      return procedureSummon(state, ctx, action);
    case 'SET_SPELL_TRAP': {
      const { uid } = action;
      const def = getDef(state, ctx, uid);
      requireMainPhase(state, ctx, '魔法・罠のセット');
      if (def.kind === 'monster') fail('モンスターは魔法＆罠ゾーンにセットできません');
      if (strict && !state.hand.includes(uid)) fail('手札のカードのみセットできます');
      let to: Location;
      if (def.spellType === 'field') {
        if (state.fz) moveCard(state, ctx, state.fz, { zone: 'gy' });
        to = { zone: 'fz' };
      } else {
        const index = action.index ?? state.stz.indexOf(null);
        if (index < 0 || state.stz[index]) fail('魔法＆罠ゾーンに空きがありません');
        to = { zone: 'stz', index };
      }
      moveCard(state, ctx, uid, to, { faceUp: false });
      state.cards[uid].enteredTurn = state.turn;
      log(state, `${def.name}をセット`, 'move');
      return;
    }
    case 'ACTIVATE_CARD':
      return activateCard(state, ctx, action.uid, action.index);
    case 'RESOLVE': {
      const inst = state.cards[action.uid];
      if (!inst.pendingResolve) fail('解決待ちのカードではありません');
      inst.pendingResolve = false;
      moveCard(state, ctx, action.uid, { zone: 'gy' });
      log(state, `${name(state, ctx, action.uid)}の効果処理完了 → 墓地へ`, 'move');
      return;
    }
    case 'ACTIVATE_EFFECT': {
      const def = getDef(state, ctx, action.uid);
      const key = action.key ?? def.name;
      const count = (state.effectUses[key] ?? 0) + 1;
      if (strict && action.limit !== undefined && count > action.limit) {
        fail(`${def.name}のこの効果は1ターンに${action.limit}度までです`);
      }
      state.effectUses[key] = count;
      if (action.silent) return;
      if (def.kind === 'spell') state.spellActivatedThisTurn = true;
      const label = action.label ? `「${action.label}」` : '';
      log(state, `${def.name}の効果${label}を発動`, 'activate');
      if (action.limit === undefined && count > 1) {
        log(state, `※ ${def.name}の効果はこのターン${count}回目です（ターン1制限に注意）`, 'warn');
      }
      return;
    }
    case 'MOVE': {
      const { uid, to } = action;
      const def = getDef(state, ctx, uid);
      const from = findLocation(state, uid);
      if (to.zone === 'mz' || to.zone === 'emz') {
        if (def.kind !== 'monster' && strict) fail('魔法・罠はモンスターゾーンに置けません');
        checkMonsterZoneFree(state, ctx, to, [uid]);
      }
      if (to.zone === 'stz' && state.stz[to.index] && state.stz[to.index] !== uid) fail(`${locLabel(to)}は使用中です`);
      if (to.zone === 'fz' && state.fz && state.fz !== uid) fail('フィールドゾーンは使用中です');
      const dest = moveCard(state, ctx, uid, to, {
        faceUp: action.faceUp,
        position: action.position,
        toBottom: action.toBottom,
      });
      // フィールドに出たターンを記録（セットした罠を同じターンに発動できない等の判定用）
      if (dest && isOnField(dest) && !isOnField(from)) state.cards[uid].enteredTurn = state.turn;
      if (dest) {
        const where = dest.zone === 'deck' ? (action.toBottom ? 'デッキの一番下' : 'デッキの一番上') : locLabel(dest);
        log(
          state,
          `${def.name}を${from ? locLabel(from) : '?'}から${where}へ${action.reason ? `（${action.reason}）` : ''}`,
          'move',
        );
      }
      return;
    }
    case 'CHANGE_POSITION': {
      const inst = state.cards[action.uid];
      requireMainPhase(state, ctx, '表示形式の変更');
      if (!isMonsterZone(findLocation(state, action.uid))) fail('フィールドのモンスターではありません');
      if (!inst.faceUp) fail('裏側表示のモンスターは反転召喚を使ってください');
      if (strict) {
        if (inst.enteredTurn === state.turn) fail('召喚・特殊召喚したターンは表示形式を変更できません');
        if (inst.positionChangedTurn === state.turn) fail('表示形式の変更はターンに1度までです');
        if (inst.attackedTurn === state.turn) fail('攻撃したモンスターは表示形式を変更できません');
      }
      inst.position = inst.position === 'atk' ? 'def' : 'atk';
      inst.positionChangedTurn = state.turn;
      log(state, `${name(state, ctx, action.uid)}を${inst.position === 'atk' ? '攻撃' : '守備'}表示に変更`, 'move');
      return;
    }
    case 'ATTACK': {
      const inst = state.cards[action.uid];
      const def = getDef(state, ctx, action.uid);
      if (strict) {
        if (state.phase !== 'BP') fail('攻撃はバトルフェイズに行います');
        if (state.turn === 1) fail('先攻1ターン目は攻撃できません');
        if (!inst.faceUp || inst.position !== 'atk') fail('表側攻撃表示のモンスターのみ攻撃できます');
        const maxAttacks = inst.doubleAttackTurn === state.turn ? 2 : 1;
        if (inst.attackedTurn === state.turn && inst.attackCount >= maxAttacks)
          fail('このモンスターは既に攻撃しています');
        if (def.cannotAttackTurnSummoned && inst.enteredTurn === state.turn)
          fail(`${def.name}は召喚・特殊召喚したターンには攻撃できません`);
      }
      if (!isMonsterZone(findLocation(state, action.uid))) fail('フィールドのモンスターではありません');
      inst.attackCount = inst.attackedTurn === state.turn ? inst.attackCount + 1 : 1;
      inst.attackedTurn = state.turn;
      if (def.attackCost) {
        state.lp -= def.attackCost;
        log(state, `攻撃宣言のコストとして${def.attackCost}LPを払った（LP ${state.lp}）`, 'info');
      }
      const dmg = def.atk ?? 0;
      state.opponentLp = Math.max(0, state.opponentLp - dmg);
      log(state, `${def.name}で直接攻撃！ ${dmg}ダメージ（相手LP ${state.opponentLp}）`, 'activate');
      if (state.opponentLp === 0 && state.status === 'playing') {
        state.status = 'won';
        state.statusReason = '相手のLPを0にした';
        log(state, '相手のLPが0になりました（勝利）', 'info');
      }
      return;
    }
    case 'SHUFFLE_DECK': {
      state.shuffleCount += 1;
      state.deck = shuffle(state.deck, mulberry32(state.seed + 7919 * state.shuffleCount));
      log(state, 'デッキをシャッフル', 'move');
      return;
    }
    case 'ATTACH': {
      const target = state.cards[action.target];
      const tdef = getDef(state, ctx, action.target);
      if (strict && tdef.frame !== 'xyz') fail('エクシーズモンスター以外には素材を重ねられません');
      if (!isMonsterZone(findLocation(state, action.target))) fail('対象がフィールドにいません');
      const def = getDef(state, ctx, action.uid);
      const from = findLocation(state, action.uid);
      if (def.frame === 'token') fail('トークンはエクシーズ素材にできません');
      // 素材になるモンスター自身の素材は墓地へ
      if (isMonsterZone(from)) {
        for (const m of [...state.cards[action.uid].overlay]) moveCard(state, ctx, m, { zone: 'gy' });
      }
      detach(state, action.uid);
      resetInstance(state.cards[action.uid]);
      state.cards[action.uid].faceUp = true;
      target.overlay.push(action.uid);
      log(state, `${def.name}を${tdef.name}のエクシーズ素材にした`, 'move');
      return;
    }
    case 'DETACH': {
      const target = state.cards[action.target];
      if (!target.overlay.includes(action.uid)) fail('そのカードは素材ではありません');
      target.overlay = target.overlay.filter((u) => u !== action.uid);
      placeRaw(state, action.uid, { zone: 'gy' }, {});
      log(
        state,
        `${name(state, ctx, action.target)}のエクシーズ素材（${name(state, ctx, action.uid)}）を取り除いた`,
        'move',
      );
      return;
    }
    case 'CREATE_TOKEN': {
      checkMonsterZoneFree(state, ctx, action.to);
      if (strict && action.to.zone === 'emz') fail('トークンはEXモンスターゾーンに出せません');
      const defId = `token-${state.nextUid}`;
      state.tokenDefs[defId] = {
        id: defId,
        name: action.name,
        kind: 'monster',
        frame: 'token',
        level: action.level,
        atk: action.atk,
        def: action.def,
        attribute: action.attribute,
        race: action.race,
        text: 'トークン',
      };
      const uid = `c${state.nextUid++}`;
      state.cards[uid] = newInstance(uid, defId);
      placeRaw(state, uid, action.to, { faceUp: true, position: action.position ?? 'atk' });
      markSummoned(state, uid);
      log(state, `${action.name}を特殊召喚`, 'summon');
      return;
    }
    case 'MILL': {
      const n = Math.min(action.count, state.deck.length);
      for (let i = 0; i < n; i++) moveCard(state, ctx, state.deck[0], { zone: 'gy' });
      log(state, `デッキの上から${n}枚を墓地へ`, 'move');
      return;
    }
    case 'CHANGE_LP': {
      state.lp += action.delta;
      log(state, `LP ${action.delta > 0 ? '+' : ''}${action.delta}（${state.lp}）`, 'info');
      return;
    }
    case 'PROC_SUMMON':
      return specialProcedure(state, ctx, action);
    case 'GRANT_SUMMON': {
      state.summonGrants.push(action.grant);
      const what = [action.grant.extraSummon && '追加の召喚', action.grant.noTribute && 'リリースなし召喚']
        .filter(Boolean)
        .join('・');
      log(state, `${action.grant.source}の効果：${what}が可能になった`, 'info');
      return;
    }
    case 'SET_COUNTERS': {
      state.cards[action.uid].counters = Math.max(0, action.value);
      log(state, `${name(state, ctx, action.uid)}のカウンター：${state.cards[action.uid].counters}`, 'info');
      return;
    }
    case 'DOUBLE_ATTACK': {
      state.cards[action.uid].doubleAttackTurn = state.turn;
      log(state, `${name(state, ctx, action.uid)}はこのターン2回攻撃できる`, 'info');
      return;
    }
    case 'BATCH': {
      for (const a of action.actions) reduce(state, a, ctx);
      return;
    }
    case 'CHAIN_PUSH': {
      const top = state.chain[state.chain.length - 1];
      if (strict && top && (action.speed < 2 || action.speed < top.speed)) {
        fail(`スペルスピード${action.speed}の効果はチェーンできません`);
      }
      state.chain.push({
        uid: action.uid,
        defId: state.cards[action.uid].defId,
        effect: action.effect,
        stepStart: action.stepStart,
        speed: action.speed,
        label: action.label,
      });
      log(state, `チェーン${state.chain.length}：${name(state, ctx, action.uid)}の効果「${action.label}」`, 'activate');
      return;
    }
    case 'CHAIN_POP': {
      const link = state.chain.pop();
      if (!link) fail('解決するチェーンがありません');
      log(state, `チェーン${state.chain.length + 1}（${ctx.db[link.defId]?.name ?? ''}）の解決が終わった`, 'info');
      return;
    }
  }
}

function activateCard(state: GameState, ctx: Ctx, uid: string, index?: number) {
  const strict = ctx.options.strict;
  const def = getDef(state, ctx, uid);
  const inst = state.cards[uid];
  const from = findLocation(state, uid);
  if (def.kind === 'monster') fail('モンスターの効果は「効果発動」を使ってください');
  if (!from) fail('カードの場所が不明です');
  const fromHand = from.zone === 'hand';
  const isSet = (from.zone === 'stz' || from.zone === 'fz') && !inst.faceUp;
  if (!fromHand && !isSet) fail('手札かセットされたカードのみ発動できます');
  const activationKey = `${def.name}:発動`;
  if (strict && def.oncePerTurnActivation && state.effectUses[activationKey]) {
    fail(`${def.name}は1ターンに1枚しか発動できません`);
  }

  if (strict) {
    if (def.kind === 'trap') {
      if (fromHand) fail('罠カードはセットしてから発動します');
      if (inst.enteredTurn === state.turn) fail('セットしたターンに罠カードは発動できません');
    } else if (def.spellType === 'quick') {
      if (isSet && inst.enteredTurn === state.turn) fail('セットしたターンに速攻魔法は発動できません');
    } else {
      requireMainPhase(state, ctx, `${def.name}の発動`);
      if (state.chain.length) fail(`${def.name}（スペルスピード1）はチェーンして発動できません`);
    }
  }

  if (fromHand) {
    let to: Location;
    if (def.spellType === 'field') {
      if (state.fz) moveCard(state, ctx, state.fz, { zone: 'gy' });
      to = { zone: 'fz' };
    } else {
      const i = index ?? state.stz.indexOf(null);
      if (i < 0 || state.stz[i]) fail('魔法＆罠ゾーンに空きがありません');
      to = { zone: 'stz', index: i };
    }
    moveCard(state, ctx, uid, to, { faceUp: true });
    inst.enteredTurn = state.turn;
  } else {
    inst.faceUp = true;
  }

  const staysOnField =
    def.spellType === 'continuous' ||
    def.spellType === 'equip' ||
    def.spellType === 'field' ||
    def.trapType === 'continuous';
  inst.pendingResolve = !staysOnField;
  state.effectUses[activationKey] = (state.effectUses[activationKey] ?? 0) + 1;
  if (def.kind === 'spell') state.spellActivatedThisTurn = true;
  log(state, `${def.name}を発動${staysOnField ? '' : '（処理後に「解決」で墓地へ）'}`, 'activate');
}

function procedureSummon(state: GameState, ctx: Ctx, action: Extract<Action, { type: 'PROCEDURE_SUMMON' }>) {
  const strict = ctx.options.strict;
  const { uid, materials, to, method } = action;
  const def = getDef(state, ctx, uid);
  const from = findLocation(state, uid);
  checkSummonable(state, ctx, uid);
  requireMainPhase(state, ctx, '召喚');
  const matDefs = materials.map((m) => getDef(state, ctx, m));
  const matNames = matDefs.map((d) => d.name).join('・');
  const label = { fusion: '融合', synchro: 'シンクロ', xyz: 'エクシーズ', link: 'リンク', ritual: '儀式' }[method];

  if (strict) {
    if (method !== 'ritual' && def.frame !== method) fail(`${def.name}は${label}モンスターではありません`);
    if (method === 'ritual' && def.frame !== 'ritual') fail(`${def.name}は儀式モンスターではありません`);
    if (method === 'ritual') {
      if (from?.zone !== 'hand') fail('儀式召喚は手札から行います');
    } else if (from?.zone !== 'extra') {
      fail(`${label}召喚はEXデッキから行います`);
    }
    if (materials.length === 0) fail('素材を選んでください');
    if (materials.includes(uid)) fail('召喚するモンスター自身は素材にできません');
  }

  switch (method) {
    case 'link': {
      if (strict) {
        requireFaceUpFieldMonsters(state, ctx, materials, 'リンク素材');
        if (!canMakeLinkRating(matDefs.map(linkMaterialOptions), def.link ?? 0)) {
          fail(`リンク素材の数が合いません（LINK-${def.link}）`);
        }
      }
      break;
    }
    case 'synchro': {
      if (strict) {
        requireFaceUpFieldMonsters(state, ctx, materials, 'シンクロ素材');
        const tuners = matDefs.filter((d) => d.tuner);
        if (tuners.length !== 1) fail('シンクロ召喚にはチューナー1体とチューナー以外のモンスターが必要です');
        if (materials.length < 2) fail('チューナー以外のモンスターが1体以上必要です');
        const sum = matDefs.reduce((s, d) => s + (levelOf(d) ?? NaN), 0);
        if (sum !== def.level)
          fail(`素材のレベル合計（${sum}）がシンクロモンスターのレベル（${def.level}）と一致しません`);
      }
      break;
    }
    case 'xyz': {
      if (strict) {
        requireFaceUpFieldMonsters(state, ctx, materials, 'エクシーズ素材');
        const need = def.xyzMaterialCount ?? 2;
        if (materials.length < need) fail(`エクシーズ素材が${need}体以上必要です`);
        if (matDefs.some((d) => levelOf(d) !== def.rank)) fail(`レベル${def.rank}のモンスターを選んでください`);
        if (matDefs.some((d) => d.frame === 'token')) fail('トークンはエクシーズ素材にできません');
      }
      break;
    }
    case 'fusion': {
      if (strict) {
        for (const m of materials) {
          const l = findLocation(state, m);
          if (l?.zone !== 'hand' && !isMonsterZone(l)) fail('融合素材は手札かフィールドから選んでください');
        }
        if (def.fusionMaterialCount && materials.length !== def.fusionMaterialCount) {
          fail(`融合素材は${def.fusionMaterialCount}体です`);
        }
      }
      break;
    }
    case 'ritual': {
      if (strict) {
        for (const m of materials) {
          const l = findLocation(state, m);
          if (l?.zone !== 'hand' && !isMonsterZone(l)) fail('儀式のリリースは手札かフィールドから選んでください');
        }
        const sum = matDefs.reduce((s, d) => s + (levelOf(d) ?? 0), 0);
        if (sum < (def.level ?? 0))
          fail(`リリースするモンスターのレベル合計（${sum}）が足りません（${def.level}以上）`);
      }
      break;
    }
  }

  const materialErr = strict
    ? ctx.scripts?.[def.id]?.materialCheck?.(makeEnv(state, ctx, uid), materials, method)
    : null;
  if (materialErr) fail(materialErr);

  // 素材を送ってから置き場所をチェックする（リンク先の判定は素材が離れた後）
  if (method === 'xyz') {
    const overlay: string[] = [];
    for (const m of materials) {
      for (const sub of [...state.cards[m].overlay]) moveCard(state, ctx, sub, { zone: 'gy' });
      detach(state, m);
      resetInstance(state.cards[m]);
      state.cards[m].faceUp = true;
      overlay.push(m);
    }
    checkMonsterZoneFree(state, ctx, to);
    checkExtraDeckPlacement(state, ctx, uid, to, from);
    moveCard(state, ctx, uid, to, { faceUp: true, position: action.position ?? 'atk' });
    state.cards[uid].overlay = overlay;
  } else {
    sendMaterials(state, ctx, materials, action.materialsTo ?? 'gy');
    checkMonsterZoneFree(state, ctx, to);
    checkExtraDeckPlacement(state, ctx, uid, to, from);
    const position = method === 'link' ? 'atk' : (action.position ?? 'atk');
    moveCard(state, ctx, uid, to, { faceUp: true, position });
  }
  markSummoned(state, uid);
  log(state, `${matNames}を素材に${def.name}を${label}召喚（${locLabel(to)}）`, 'summon');
}

function specialProcedure(state: GameState, ctx: Ctx, action: Extract<Action, { type: 'PROC_SUMMON' }>) {
  const { uid, materials, to } = action;
  const def = getDef(state, ctx, uid);
  const proc = ctx.scripts?.[def.id]?.procedures?.[action.proc];
  if (!proc) fail(`${def.name}の召喚方法が見つかりません`);
  const from = findLocation(state, uid);
  if (ctx.options.strict) {
    requireMainPhase(state, ctx, '特殊召喚');
    if (!from || !(proc.summonFrom as string[]).includes(from.zone))
      fail(`${def.name}はこの場所から特殊召喚できません`);
    if (materials.includes(uid)) fail('召喚するモンスター自身は選べません');
    const key = `${def.name}:召喚条件`;
    if (proc.oncePerTurn && state.effectUses[key]) fail(`${def.name}のこの方法での特殊召喚は1ターンに1度です`);
    const err = proc.validate(makeEnv(state, ctx, uid), materials);
    if (err) fail(err);
  }
  if (proc.oncePerTurn) state.effectUses[`${def.name}:召喚条件`] = 1;
  const matNames = materials.map((m) => name(state, ctx, m));
  for (const m of materials) moveCard(state, ctx, m, { zone: proc.materialsTo });
  checkMonsterZoneFree(state, ctx, to);
  checkExtraDeckPlacement(state, ctx, uid, to, from);
  moveCard(state, ctx, uid, to, { faceUp: true, position: action.position ?? 'atk' });
  markSummoned(state, uid);
  const cost = matNames.length
    ? `${matNames.join('・')}を${{ gy: '墓地へ送り', deck: 'デッキに戻し', banished: '除外し' }[proc.materialsTo]}、`
    : '';
  log(state, `${cost}${def.name}を特殊召喚（${proc.label}）`, 'summon');
}

/** 効果処理で選べるカード */
export function candidates(state: GameState, zones: string[]): string[] {
  const out: string[] = [];
  for (const z of zones) {
    if (z === 'deck' || z === 'hand' || z === 'gy' || z === 'banished' || z === 'extra') out.push(...state[z]);
    if (z === 'monsters' || z === 'field') out.push(...fieldMonsters(state));
    if (z === 'spelltraps' || z === 'field')
      out.push(...state.stz.filter((u): u is string => !!u), ...(state.fz ? [state.fz] : []));
  }
  return [...new Set(out)];
}

export type { CardFilter };

// ===== リプレイ =====

/** 初期状態にアクション列を順に適用する（アンドゥ・ルート再生に使用） */
export function replay(initial: GameState, actions: Action[], ctx: Ctx): GameState {
  let s = initial;
  for (const a of actions) {
    const r = applyAction(s, a, ctx);
    if (!r.ok) throw new Error(`リプレイに失敗: ${r.error}`);
    s = r.state;
  }
  return s;
}
