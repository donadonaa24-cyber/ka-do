import type { CardScript } from '../engine/scripts';
import type { CardDef, DeckList } from '../engine/types';
import { TEST_CARDS, TEST_DECK } from './testCards';
import { TOON_CARD_DATA } from './toonCards.generated';
import { TOON_OVERRIDES, TOON_SCRIPTS } from './toonScripts';
import { OTHER_CARD_DATA } from './otherCards.generated';
import { OTHER_SCRIPTS } from './otherScripts';

const TOON_CARDS: CardDef[] = TOON_CARD_DATA.map((c) => ({ ...c, ...TOON_OVERRIDES[c.id] }));

export const ALL_CARDS: CardDef[] = [...TOON_CARDS, ...OTHER_CARD_DATA, ...TEST_CARDS];

/** デッキ編集で選べるカード（動作確認用の架空カードは除く） */
export const EDITABLE_CARDS: CardDef[] = [...TOON_CARDS, ...OTHER_CARD_DATA];

export const CARD_DB: Record<string, CardDef> = Object.fromEntries(ALL_CARDS.map((c) => [c.id, c]));

export const CARD_SCRIPTS: Record<string, CardScript> = { ...TOON_SCRIPTS, ...OTHER_SCRIPTS };

const n = (id: string, count: number) => Array<string>(count).fill(id);

/** gachi-matome のデッキレシピ（トゥーン） */
export const TOON_DECK: DeckList = {
  name: 'トゥーン',
  main: [
    // モンスター 21枚
    ...n('28711704', 1), // トゥーン・カオス・ソルジャー
    ...n('53183600', 1), // ブルーアイズ・トゥーン・ドラゴン
    ...n('21296502', 1), // トゥーン・ブラック・マジシャン
    ...n('8915275', 2), // エビル・ボックス
    ...n('90960358', 1), // トゥーン・ブラック・マジシャン・ガール
    ...n('34314989', 2), // 闇の眼を持つ幻想師・ノー・フェイス
    ...n('64116319', 1), // トゥーン・ハーピィ・レディ
    ...n('45536531', 3), // ファニー・ダーク・ラビット
    ...n('59438930', 1), // 幽鬼うさぎ
    ...n('14558127', 2), // 灰流うらら
    ...n('23434538', 1), // 増殖するＧ
    ...n('55363218', 1), // カートゥーン・シェード
    ...n('72921536', 3), // コミックキャット
    ...n('94145021', 1), // ドロール＆ロックバード
    // 魔法 9枚
    ...n('91500017', 3), // トゥーンのしおり
    ...n('89997728', 1), // トゥーンのもくじ
    ...n('70560957', 1), // トゥーン・ロールバック
    ...n('65681983', 1), // 抹殺の指名者
    ...n('22283204', 1), // ティマイオスの眼光
    ...n('7293697', 1), // 完全なる世界 トゥーン・ワールド
    ...n('43175858', 1), // トゥーン・キングダム
    // 罠 8枚
    ...n('10045474', 3), // 無限泡影
    ...n('6325660', 1), // 霆王の閃光（ドミナス・スパーク）
    ...n('66247039', 2), // 聖なる心のバリア －マインドフォース－
    ...n('34298391', 1), // 心を見通す眼
    ...n('53094821', 1), // トゥーン・テラー
    // 手札誘発 2枚（トゥーンのかばん・霆王の閃光2枚・センサー万別と入れ替え）
    ...n('42141493', 2), // マルチャミー・フワロス
  ],
  extra: [
    ...n('71808988', 2), // ブルーアイズ・トゥーン・アルティメットドラゴン
    ...n('37818794', 1), // 超魔導竜騎士－ドラグーン・オブ・レッドアイズ
    ...n('59400890', 1), // 滅びの黒魔術師
    ...n('93039339', 3), // 厄災の星ティ・フォン（レシピの「3 1」は3枚と解釈）
    ...n('4731783', 1), // 光なき影 ア＝バオ・ア・クゥー
    ...n('45819647', 1), // 神聖魔皇后セレーネ
    ...n('53904087', 1), // 神書の使いラハムゥ
    ...n('65741786', 1), // Ｉ：Ｐマスカレーナ
    ...n('29301450', 1), // Ｓ：Ｐリトルナイト
    ...n('50277355', 1), // クロシープ
    ...n('94259633', 2), // サクリファイス・アニマ（レシピに2行あったため2枚）
  ],
};

/** 最初から入っているデッキ（編集はコピーして行う）。テスト用デッキは動作確認専用なので含めない */
export const BUILTIN_DECKS: DeckList[] = [TOON_DECK];

export { TEST_DECK };
