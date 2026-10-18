import type { Action, Ctx } from './game';
import type { CardFilter } from './filters';
import type { CardDef, GameState, Location } from './types';

/** 効果・召喚条件の判定に渡す盤面の見え方 */
export interface Env {
  state: GameState;
  ctx: Ctx;
  /** 効果を使うカード */
  self: string;
  def: (uid: string) => CardDef;
  loc: (uid: string) => Location | null;
  toonWorld: boolean;
  isToon: (uid: string) => boolean;
  matches: (uid: string, filter: CardFilter) => boolean;
  /** 同じ効果の処理でこれまでのステップに選んだカード（ステップ順） */
  picks?: string[][];
}

/** 「通常召喚できない」モンスターなどの召喚条件による特殊召喚 */
export interface ProcedureDef {
  label: string;
  hint: string;
  /** コストにするカードを選ぶ場所。空なら選ばない */
  from: PickZone[];
  /** コストにできるカード（候補を絞るため。最終的な判定は validate） */
  materialFilter?: (env: Env, uid: string) => boolean;
  /** コストにしたカードの移動の理由（「リリース」なら「リリースされた場合」の効果が使える） */
  materialsReason?: string;
  /** コストにしたカードの行き先 */
  materialsTo: 'gy' | 'deck' | 'banished';
  /** 「１ターンに１度」の召喚条件 */
  oncePerTurn?: boolean;
  /** 召喚する前のカードの場所 */
  summonFrom: ('hand' | 'extra' | 'gy')[];
  /** 条件を満たさない場合はエラーメッセージを返す */
  validate: (env: Env, materials: string[]) => string | null;
}

export type PickZone = 'deck' | 'hand' | 'gy' | 'banished' | 'extra' | 'monsters' | 'spelltraps' | 'field';

/** 効果処理の1ステップ。選択が必要なものはUIで選ばせ、結果をアクションに変換する */
export type Step =
  | {
      op: 'pick';
      prompt: string;
      /** 発動時に払うコスト（チェーンに積む前に処理する） */
      cost?: boolean;
      from: PickZone[];
      filter?: CardFilter;
      /** CardFilter で表せない条件 */
      where?: (env: Env, uid: string) => boolean;
      min?: number;
      max?: number;
      /** 選ぶ枚数を盤面から決める（min=max になる） */
      count?: (env: Env) => number;
      /** 選ぶ枚数の範囲を盤面（前のステップで選んだカードなど）から決める */
      range?: (env: Env) => [number, number];
      /** 選んだ後に処理の種類を選ばせる（例: 手札に加える／セットする） */
      modes?: string[];
      /** 選んだ後に出す（置く）ゾーンを選ばせる */
      zone?: 'monster' | 'stz';
      then: (env: Env, picked: string[], zone: Location | null, mode: number) => Action[];
    }
  | {
      op: 'place';
      prompt: string;
      zone: 'monster' | 'stz';
      cost?: boolean;
      then: (env: Env, zone: Location) => Action[];
    }
  | { op: 'do'; cost?: boolean; then: (env: Env) => Action[] };

export interface EffectDef {
  label: string;
  /** 発動できるカードの場所 */
  from: ('hand' | 'monster' | 'spelltrap' | 'field-zone' | 'gy' | 'banished')[];
  /** ターン制限の管理キー（省略時は制限なし） */
  key?: string;
  limit?: number;
  /** 「１ターンに１度」がカード1枚ごと（同名カードでも別々に使える） */
  perCard?: boolean;
  /** perCard でも、このカード名の効果として1ターンに使える回数（例：完全なる世界②は3度まで） */
  nameLimit?: number;
  /** 発動条件。満たさない場合はメッセージを返す */
  condition?: (env: Env) => string | null;
  /** 魔法・罠カードの発動そのもの */
  isCardActivation?: boolean;
  /** 相手がいる時にしか意味がない効果（ルート探索では使わない） */
  opponentOnly?: boolean;
  /** 「召喚・特殊召喚した場合」の効果：そのターンに出た時に1回だけ使える */
  onSummon?: boolean;
  /** 誘発効果（「〜した場合に発動できる」など）。相手ターンにも発動できる */
  trigger?: boolean;
  /** 発動しない効果（「〜時に適用する」など）。チェーンに乗らず、完全なる世界③の対象にもならない */
  applied?: boolean;
  /** フィールドのカードを対象にとる効果（白き乙女③など「対象になった時」の効果をチェーンできる） */
  targets?: boolean;
  /** スペルスピード。省略時は速攻魔法・罠の発動なら2（カウンター罠は3）、それ以外は1 */
  speed?: 1 | 2 | 3;
  steps: Step[];
}

export interface CardScript {
  procedures?: ProcedureDef[];
  effects?: EffectDef[];
  /**
   * 表側で存在する限り、他のカードが発動した効果が処理される際に、条件に合う自分のモンスター1体を
   * その処理後まで除外できる（発動しない効果。元々のカード名が同じモンスターには1ターンに1度まで）
   */
  tempBanish?: { label: string; key: string; filter: CardFilter };
  /** 融合・S・X・L召喚の素材のカード固有の条件。満たさない場合はメッセージを返す */
  materialCheck?: (
    env: Env,
    materials: string[],
    method: 'fusion' | 'synchro' | 'xyz' | 'link' | 'ritual',
  ) => string | null;
}
