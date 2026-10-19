// ===== カード定義 =====

export type CardKind = 'monster' | 'spell' | 'trap';

export type MonsterFrame = 'normal' | 'effect' | 'ritual' | 'fusion' | 'synchro' | 'xyz' | 'link' | 'token';

export type SpellType = 'normal' | 'quick' | 'continuous' | 'equip' | 'field' | 'ritual';
export type TrapType = 'normal' | 'continuous' | 'counter';

export type Attribute = '光' | '闇' | '炎' | '水' | '地' | '風' | '神';

/** リンクマーカー（自分から見た方向） */
export type LinkMarker = 'TL' | 'T' | 'TR' | 'L' | 'R' | 'BL' | 'B' | 'BR';

export interface CardDef {
  id: string;
  name: string;
  kind: CardKind;
  text: string;
  // --- モンスター ---
  frame?: MonsterFrame;
  attribute?: Attribute;
  race?: string;
  level?: number; // レベル
  rank?: number; // ランク
  link?: number; // リンクマーカー数
  linkMarkers?: LinkMarker[];
  atk?: number;
  def?: number;
  tuner?: boolean;
  pendulumScale?: number;
  /** 特殊召喚モンスター（通常召喚不可） */
  cannotNormalSummon?: boolean;
  /** エクシーズ素材の必要数（既定 2） */
  xyzMaterialCount?: number;
  /** 融合素材の必要数（チェックに使用。未指定ならチェックしない） */
  fusionMaterialCount?: number;
  /** 素材条件の補足（表示用） */
  materialText?: string;
  /** カテゴリ（「トゥーン」カードなど） */
  archetypes?: string[];
  /** トゥーンモンスター */
  toon?: boolean;
  /** 「トゥーン・ワールド」が存在する限りトゥーンモンスターとして扱う */
  toonWithWorld?: boolean;
  /** フィールドゾーンにある限り「トゥーン・ワールド」として扱う */
  treatedAsToonWorld?: boolean;
  /** フィールド・墓地に存在する限りこのカード名として扱う */
  treatedAsName?: string;
  /** 召喚・特殊召喚したターンは攻撃できない */
  cannotAttackTurnSummoned?: boolean;
  /** 攻撃宣言時に払うLP */
  attackCost?: number;
  /** 1度のバトルフェイズ中に攻撃できる回数（既定 1） */
  attacksPerBattle?: number;
  /** 「このカード名のカードは１ターンに１枚しか発動できない」 */
  oncePerTurnActivation?: boolean;
  /** チューナー2体以上でS召喚する（青眼の究極霊竜など） */
  multiTunerSynchro?: boolean;
  /** 「このカードは〇〇召喚でしか特殊召喚できない」 */
  onlyBy?: 'fusion' | 'synchro' | 'xyz' | 'link' | 'ritual';
  /** 手札・墓地では通常モンスターとして扱う（白き霊龍） */
  normalInHandGy?: boolean;
  /** 表側で存在する限り、自分はこの条件のモンスターしか特殊召喚できない */
  summonLock?: import('./filters').CardFilter;
  // --- 魔法・罠 ---
  spellType?: SpellType;
  trapType?: TrapType;
}

export const EXTRA_FRAMES: MonsterFrame[] = ['fusion', 'synchro', 'xyz', 'link'];

export function isExtraDeckCard(def: CardDef): boolean {
  return def.kind === 'monster' && !!def.frame && EXTRA_FRAMES.includes(def.frame);
}

// ===== 盤面 =====

export type PileZone = 'deck' | 'hand' | 'extra' | 'gy' | 'banished';
export type FieldZone = 'mz' | 'emz' | 'stz' | 'fz';
export type ZoneName = PileZone | FieldZone | 'omz' | 'oemz' | 'ostz' | 'ofz' | OppPile | 'odeck';

export type Location =
  | { zone: PileZone }
  | { zone: 'mz'; index: number } // メインモンスターゾーン 0-4
  | { zone: 'emz'; index: number } // エクストラモンスターゾーン 0(左) / 1(右)
  | { zone: 'stz'; index: number } // 魔法＆罠ゾーン 0-4（0,4はPゾーン兼用）
  | { zone: 'fz' } // フィールドゾーン
  // --- 相手（練習用に手で置く） ---
  | { zone: 'omz'; index: number } // 相手のメインモンスターゾーン
  | { zone: 'oemz'; index: number } // 相手が使っているEXモンスターゾーン（自分から見て 0(左) / 1(右)）
  | { zone: 'ostz'; index: number } // 相手の魔法＆罠ゾーン
  | { zone: 'ofz' }
  | { zone: OppPile }
  | { zone: 'odeck' }; // CPU戦：CPUのデッキ（見せない）

export type OppPile = 'ogy' | 'obanished' | 'ohand';

/** 相手の盤面（相手は存在しないので、練習のために手で置く） */
export interface OppBoard {
  mz: (string | null)[];
  /** EXモンスターゾーンは共有。相手が使っている方（古い記録には無い） */
  emz?: (string | null)[];
  stz: (string | null)[];
  fz: string | null;
  gy: string[];
  banished: string[];
  /** 手札に戻ったカード */
  hand: string[];
  /** CPU戦：CPUのデッキ（写したもの。練習では無い） */
  deck?: string[];
  /** CPU戦・通信対戦：相手のEXデッキの枚数（練習では無い） */
  extraCount?: number;
}

export type BattlePosition = 'atk' | 'def';

export interface CardInstance {
  uid: string;
  defId: string;
  faceUp: boolean;
  /** モンスターゾーン上での表示形式 */
  position: BattlePosition;
  /** エクシーズ素材 */
  overlay: string[];
  counters: number;
  /** このターンに召喚・特殊召喚・反転召喚・セットされたターン */
  enteredTurn: number | null;
  /** 表示形式を変更したターン */
  positionChangedTurn: number | null;
  /** 攻撃したターン */
  attackedTurn: number | null;
  /** 発動して解決待ち（解決後に墓地へ送られる魔法・罠） */
  pendingResolve: boolean;
  /** エクストラデッキに表側で存在する（Pモンスター） */
  faceUpInExtra: boolean;
  /** attackedTurn のターンに攻撃した回数 */
  attackCount: number;
  /** 2回攻撃できるターン */
  doubleAttackTurn: number | null;
  /** フィールドに出るたびに変わる番号（「召喚した時」の効果を1回に限るため） */
  entryId: number;
  /** 召喚・特殊召喚でフィールドに出た時の entryId（効果で除外されて戻っただけなら一致しない） */
  summonedEntry: number | null;
  /** CPU戦：CPUのゲームでのカード（相手の盤面に写したカードの対応） */
  syncKey?: string;
  /** 効果が無効になっているターン（エフェクト・ヴェーラー・無限泡影など） */
  negatedTurn?: number;
  /** フィールドにいる限り効果が無効（無効にした時の entryId。移動すると entryId が変わって元に戻る） */
  negatedEntry?: number;
  /** タイミングを逃す判定：このカードに最後に何かが起きた処理のまとまり */
  eventGroup?: number;
  /** 最後に召喚・特殊召喚したターン（フィールドを離れても残る。「召喚した時に適用する」効果の判定用） */
  summonedTurn?: number;
  /** 召喚の種類（「S召喚したこのカード」などの判定用） */
  summonType: SummonType | null;
  /** 効果で変わったレベル（フィールドを離れると戻る） */
  levelMod: number;
  /** 効果で変わった攻撃力・守備力（フィールドを離れると戻る） */
  atkMod?: number;
  defMod?: number;
  /** ターン終了時まで変わった攻撃力・守備力 */
  turnAtkMod?: number;
  turnDefMod?: number;
  /** 「攻撃力が〜になる」効果で決まった元の攻撃力 */
  atkSet?: number;
  /** 装備カードとして、装備したモンスターの攻撃力・守備力を上げる量 */
  equipAtk?: number;
  equipDef?: number;
  /** 最後に移動した順番・ターン・元の場所・理由（「墓地へ送られた場合」などの判定用） */
  movedAt: number;
  movedTurn: number | null;
  movedFrom: ZoneName | null;
  movedReason: string | null;
  /** 装備カードとして装備しているモンスター */
  equippedTo: string | null;
  /** 正規の方法で召喚された（EXデッキ・儀式モンスターを墓地などから特殊召喚できる条件） */
  properlySummoned: boolean;
  /** エンドフェイズに破壊される（青眼の精霊龍③で出したモンスターなど） */
  destroyAtEnd: boolean;
  /** エンドフェイズに除外される（ＰＳＹフレームギアの効果で特殊召喚したモンスター） */
  banishAtEnd?: boolean;
  /** 相手のカード（練習用に手で置いたもの） */
  opp?: boolean;
  /** 相手のカードが使った「表側で存在する限り1度だけ」の効果 */
  oppSpent?: string[];
}

export type SummonType = 'normal' | 'special' | 'fusion' | 'synchro' | 'xyz' | 'link' | 'ritual';

/** チェーンに積まれた効果。解決はスクリプトの effect 番号の stepStart 以降を実行する */
export interface ChainLink {
  uid: string;
  defId: string;
  /** スクリプトの effects の番号 */
  effect: number;
  /** 解決で実行する最初のステップ（それより前はコストとして発動時に処理済み） */
  stepStart: number;
  /** スペルスピード */
  speed: number;
  label: string;
  /** 誘発効果（同時に発動条件を満たした誘発効果は、スペルスピード1でもチェーンを組める） */
  trigger?: boolean;
  /** 通信対戦：このチェーンに相手が応答した（使わなかった・使った） */
  oppPassed?: boolean;
  /** 相手（練習用の相手AI）の妨害。値は妨害の種類（oppAI.ts） */
  opp?: string;
  /** 相手の妨害が対象にしたチェーン番号（0始まり）・カード */
  targetLink?: number;
  target?: string;
  /** 発動・効果が無効にされた（destroy：無効にして破壊） */
  negated?: 'destroy' | 'effect';
  /** 発動した場所（hand / monster / spelltrap / field-zone / gy / banished） */
  from?: string;
}

/** 効果で得た追加の召喚権・リリースなし召喚 */
export interface SummonGrant {
  /** 効果の出どころ（表示用） */
  source: string;
  /** 通常召喚に加えて行える召喚 */
  extraSummon: boolean;
  /** リリースなしで召喚できる */
  noTribute: boolean;
  /** 対象にできるモンスター */
  filter: import('./filters').CardFilter;
  /** ターン終了時に消える */
  thisTurnOnly: boolean;
}

export type Phase = 'DP' | 'SP' | 'M1' | 'BP' | 'M2' | 'EP';

/**
 * 戦闘の段階。battle：攻撃宣言後のバトルステップ／damage：ダメージステップ開始時〜ダメージ計算前／
 * calc：ダメージ計算時／end：ダメージ計算後〜ダメージステップ終了時
 */
export type BattleStep = 'battle' | 'damage' | 'calc' | 'end';

export const BATTLE_STEP_LABEL: Record<BattleStep, string> = {
  battle: 'バトルステップ（攻撃宣言後）',
  damage: 'ダメージステップ開始時（ダメージ計算前）',
  calc: 'ダメージ計算時',
  end: 'ダメージ計算後（ダメージステップ終了時へ）',
};

export interface Battle {
  attacker: string;
  /** 攻撃対象のモンスター（null は直接攻撃） */
  target: string | null;
  /** 相手（練習用）のモンスターの攻撃 */
  byOpp: boolean;
  step: BattleStep;
  /** 攻撃宣言時の、攻撃される側のモンスターの数（変われば巻き戻し） */
  defenders: number;
  /** 戦闘で破壊が確定したモンスター（ダメージステップ終了時に墓地へ送る） */
  destroyed?: string[];
  /** ダメージステップ終了時まで除外したカードと、戻すゾーン */
  returnAtEnd?: { uid: string; index: number }[];
  /** 攻撃した相手モンスターが戦闘で破壊されなかった（青眼の双爆裂龍③） */
  targetSurvived?: boolean;
}

export const PHASE_ORDER: Phase[] = ['DP', 'SP', 'M1', 'BP', 'M2', 'EP'];

export const PHASE_LABEL: Record<Phase, string> = {
  DP: 'ドローフェイズ',
  SP: 'スタンバイフェイズ',
  M1: 'メインフェイズ1',
  BP: 'バトルフェイズ',
  M2: 'メインフェイズ2',
  EP: 'エンドフェイズ',
};

export interface LogEntry {
  turn: number;
  phase: Phase;
  text: string;
  kind: 'info' | 'summon' | 'activate' | 'move' | 'warn';
}

export interface GameState {
  seed: number;
  cards: Record<string, CardInstance>;
  /** トークンなど実行時に生成された定義 */
  tokenDefs: Record<string, CardDef>;
  deck: string[]; // [0] がデッキトップ
  hand: string[];
  extra: string[];
  gy: string[]; // 末尾が一番上
  banished: string[];
  mz: (string | null)[];
  emz: (string | null)[];
  stz: (string | null)[];
  fz: string | null;
  turn: number;
  phase: Phase;
  lp: number;
  /** 相手は存在しないが、ワンキル練習用にダメージを記録する */
  opponentLp: number;
  normalSummonUsed: boolean;
  /** このターンに効果を使ったカード名 → 回数（ターン1の確認用） */
  effectUses: Record<string, number>;
  status: 'playing' | 'lost' | 'won';
  statusReason?: string;
  log: LogEntry[];
  nextUid: number;
  /** ゲーム中にシャッフルした回数（リプレイの再現用） */
  shuffleCount: number;
  summonGrants: SummonGrant[];
  /** 積まれているチェーン（末尾が一番上＝最後に発動したもの） */
  chain: ChainLink[];
  /** このターンに魔法カードの効果が発動したか */
  spellActivatedThisTurn: boolean;
  /** このターンまで、自分のモンスターは直接攻撃できない（Ｓ：Ｐリトルナイト①・マインドフォースなど） */
  noDirectAttackUntil?: number;
  /** デッキから手札に加えられないターン（ドロール＆ロックバード） */
  noDeckToHandTurn?: number;
  /** ドロー以外でデッキから手札に加えたターン（ドロール＆ロックバードの発動条件） */
  deckToHandTurn?: number;
  /** 戦闘中（攻撃宣言からダメージステップ終了まで） */
  battle?: Battle | null;
  /** タイミングを逃す判定：処理のまとまりの番号と、最後に何かが起きたまとまり */
  timingGroup?: number;
  lastEventGroup?: number;
  /** ターン終了時までのEXデッキからの特殊召喚の制限（青眼龍轟臨・シンクロ・ランブルなど） */
  extraLocks: { source: string; filter: import('./filters').CardFilter }[];
  /** 相手ターン（相手は存在しないので、相手ターンに使える効果を練習するためのターン） */
  opponentTurn: boolean;
  /** 相手の盤面（練習用。古い記録との互換のため省略可） */
  opp?: OppBoard;
}

export interface DeckList {
  name: string;
  main: string[]; // カードIDの配列（枚数分）
  extra: string[];
  /** サイドデッキ（ゲームでは使わない。デッキ編集でメイン・EXと入れ替える） */
  side?: string[];
}

export interface GameOptions {
  /** ルールチェックを行う（オフにすると自由移動のみ） */
  strict: boolean;
  /** 相手の盤面の妨害を自動で使う（CPU戦のCPUのゲームでは、使うかはプレイヤーが選ぶので false） */
  oppAI?: boolean;
  /** 通信対戦：相手が妨害を使えるなら、効果の発動をチェーンに積んで相手の応答を待つ */
  oppAsk?: boolean;
}
