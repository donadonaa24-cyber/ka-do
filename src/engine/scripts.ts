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
}

/** 「通常召喚できない」モンスターなどの召喚条件による特殊召喚 */
export interface ProcedureDef {
  label: string;
  hint: string;
  /** コストにするカードを選ぶ場所。空なら選ばない */
  from: PickZone[];
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
      from: PickZone[];
      filter?: CardFilter;
      /** CardFilter で表せない条件 */
      where?: (env: Env, uid: string) => boolean;
      min?: number;
      max?: number;
      /** 選ぶ枚数を盤面から決める（min=max になる） */
      count?: (env: Env) => number;
      /** 選んだ後に処理の種類を選ばせる（例: 手札に加える／セットする） */
      modes?: string[];
      /** 選んだ後に出す（置く）ゾーンを選ばせる */
      zone?: 'monster' | 'stz';
      then: (env: Env, picked: string[], zone: Location | null, mode: number) => Action[];
    }
  | { op: 'place'; prompt: string; zone: 'monster' | 'stz'; then: (env: Env, zone: Location) => Action[] }
  | { op: 'do'; then: (env: Env) => Action[] };

export interface EffectDef {
  label: string;
  /** 発動できるカードの場所 */
  from: ('hand' | 'monster' | 'spelltrap' | 'field-zone' | 'gy' | 'banished')[];
  /** ターン制限の管理キー（省略時は制限なし） */
  key?: string;
  limit?: number;
  /** 「１ターンに１度」がカード1枚ごと（同名カードでも別々に使える） */
  perCard?: boolean;
  /** 発動条件。満たさない場合はメッセージを返す */
  condition?: (env: Env) => string | null;
  /** 魔法・罠カードの発動そのもの */
  isCardActivation?: boolean;
  /** 相手がいる時にしか意味がない効果（ルート探索では使わない） */
  opponentOnly?: boolean;
  /** 「召喚・特殊召喚した場合」の効果：そのターンに出た時に1回だけ使える */
  onSummon?: boolean;
  steps: Step[];
}

export interface CardScript {
  procedures?: ProcedureDef[];
  effects?: EffectDef[];
  /** 融合・S・X・L召喚の素材のカード固有の条件。満たさない場合はメッセージを返す */
  materialCheck?: (env: Env, materials: string[], method: 'fusion' | 'synchro' | 'xyz' | 'link' | 'ritual') => string | null;
}
