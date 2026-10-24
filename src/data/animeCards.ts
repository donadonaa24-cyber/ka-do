import type { CardDef } from '../engine/types';
import { TG_CARD_DATA } from './tgCards.generated';

/**
 * アニメ版の効果を持つカード（OCG版とは別のカード）。カード名・ステータス・召喚条件はOCG版と同じで、効果だけアニメ版。
 * 効果の処理は animeScripts.ts で定義する。
 */

const ANIME = 'アニメ版';
const ocg = (id: string) => TG_CARD_DATA.find((c) => c.id === id)!;
/** OCG版のカードを元に、効果のテキストだけアニメ版にする（召喚条件の行はOCG版のまま） */
const anime = (base: CardDef, effects: string): CardDef => {
  const lines = base.text.split('\n');
  const first = lines.findIndex((l) => /^[①-⑳]/.test(l));
  const conditions = first < 0 ? lines : lines.slice(0, first);
  return { ...base, id: `anime-${base.id}`, variant: ANIME, text: [...conditions, effects].join('\n') };
};

/** シューティング・クェーサー・ドラゴン（OCG版のステータス・召喚条件） */
const SHOOTING_QUASAR: CardDef = {
  id: '35952884',
  name: 'シューティング・クェーサー・ドラゴン',
  kind: 'monster',
  frame: 'synchro',
  attribute: '光',
  race: 'ドラゴン族',
  level: 12,
  atk: 4000,
  def: 4000,
  onlyBy: 'synchro',
  materialText: 'Ｓモンスターのチューナー＋チューナー以外のＳモンスター２体以上',
  text: 'Ｓモンスターのチューナー＋チューナー以外のＳモンスター２体以上\nこのカードはＳ召喚でしか特殊召喚できない。',
};

export const ANIME_CARD_DATA: CardDef[] = [
  anime(
    ocg('51447164'),
    [
      '①：このカードを対象とする相手の魔法・罠カードの発動を無効にし破壊する。',
      '②：相手ターンに１度、このカード以外の自分フィールドのモンスター１体を除外して発動できる。このカードは相手の攻撃対象にならない。（この効果でモンスターが除外された時、そのモンスターの攻撃力分、このカードの攻撃力を下げる）',
      '③：このカードが戦闘で破壊された時、墓地からＳモンスターのチューナー１体とチューナー以外のＳモンスター１体を特殊召喚できる。',
    ].join('\n'),
  ),
  {
    // ＴＧ ハルバード・キャノン：S召喚でしか特殊召喚できない（OCG版と同じ）
    onlyBy: 'synchro',
    ...anime(
      ocg('97836203'),
      [
        '①：１ターンに１度、モンスターの召喚・反転召喚・特殊召喚を無効にし、そのモンスター及び相手フィールドの特殊召喚されたモンスターをすべて破壊する。',
        '②：このカードは相手のモンスター効果を受けない。',
        '③：このカードがフィールドから離れた時、このカードのシンクロ素材としたモンスター一組を墓地から特殊召喚できる。',
      ].join('\n'),
    ),
  },
  {
    ...SHOOTING_QUASAR,
    id: 'anime-35952884',
    variant: ANIME,
    attacksFromMaterials: 3,
    text: [
      SHOOTING_QUASAR.text,
      '①：フィールド上のこのカード以外のカードの効果を受けない。',
      '②：このカードが攻撃する時、その戦闘を行う相手モンスターの効果は無効化される。',
      '③：このカードの攻撃回数は、そのシンクロ素材としたモンスターの数と同じになる（最低3回）。',
      '④：このカードがフィールドを離れた時、エクストラデッキから「シューティング・スター・ドラゴン」1体を特殊召喚できる。',
    ].join('\n'),
  },
  // シューティング・クェーサー・ドラゴン（アニメ版）④で特殊召喚する（OCG版。効果は「効果発動（記録）」で手動）
  {
    id: '24696097',
    name: 'シューティング・スター・ドラゴン',
    kind: 'monster',
    frame: 'synchro',
    attribute: '風',
    race: 'ドラゴン族',
    level: 10,
    atk: 3300,
    def: 2500,
    materialText: 'Ｓモンスターのチューナー＋「スターダスト・ドラゴン」',
    text: 'Ｓモンスターのチューナー＋「スターダスト・ドラゴン」\n①：１ターンに１度、発動できる。\n自分のデッキの上から５枚めくってデッキに戻す。\nこのターンこのカードはめくった中のチューナーの数まで攻撃できる。\n②：１ターンに１度、フィールドのカードを破壊する効果の発動時に発動できる。\nその効果を無効にし破壊する。\n③：１ターンに１度、相手の攻撃宣言時に攻撃モンスターを対象として発動できる。\nフィールドのこのカードを除外し、その攻撃を無効にする。\n④：この③の効果で除外されたターンのエンドフェイズに発動する。\nこのカードを特殊召喚する。',
  },
];
