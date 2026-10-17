// ===== カード定義 =====

export type CardKind = 'monster' | 'spell' | 'trap';

export type MonsterFrame =
  | 'normal'
  | 'effect'
  | 'ritual'
  | 'fusion'
  | 'synchro'
  | 'xyz'
  | 'link'
  | 'token';

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
  /** 「このカード名のカードは１ターンに１枚しか発動できない」 */
  oncePerTurnActivation?: boolean;
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
export type ZoneName = PileZone | FieldZone;

export type Location =
  | { zone: PileZone }
  | { zone: 'mz'; index: number } // メインモンスターゾーン 0-4
  | { zone: 'emz'; index: number } // エクストラモンスターゾーン 0(左) / 1(右)
  | { zone: 'stz'; index: number } // 魔法＆罠ゾーン 0-4（0,4はPゾーン兼用）
  | { zone: 'fz' }; // フィールドゾーン

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
  /** このターンに魔法カードの効果が発動したか */
  spellActivatedThisTurn: boolean;
}

export interface DeckList {
  name: string;
  main: string[]; // カードIDの配列（枚数分）
  extra: string[];
}

export interface GameOptions {
  /** ルールチェックを行う（オフにすると自由移動のみ） */
  strict: boolean;
}
