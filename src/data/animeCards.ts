import type { CardDef } from '../engine/types';
import { SHOOTING_QUASAR } from './signerCards';
import { TG_CARD_DATA } from './tgCards.generated';

/**
 * アニメ版の効果を持つカード（OCG版とは別のカード）。カード名・ステータス・召喚条件はOCG版と同じで、効果だけアニメ版。
 * 効果の処理は animeScripts.ts で定義する。
 */

const ANIME = 'アニメ版';
const ocg = (id: string) => TG_CARD_DATA.find((c) => c.id === id)!;
/** OCG版のカードを元に、効果のテキストだけアニメ版にする（召喚条件の行はOCG版のまま） */
const anime = (base: CardDef, effects: string[]): CardDef => {
  const lines = base.text.split('\n');
  const first = lines.findIndex((l) => /^[①-⑳]/.test(l));
  const conditions = first < 0 ? lines : lines.slice(0, first);
  return { ...base, id: `anime-${base.id}`, variant: ANIME, text: [...conditions, ...effects].join('\n') };
};

export const ANIME_CARD_DATA: CardDef[] = [
  {
    ...anime(ocg('51447164'), [
      'このカードのＳ召喚は相手ターンでも行う事ができる。',
      '①：手札を１枚墓地へ送る事で、相手の魔法・罠によるこのカードへの効果を無効にする。',
      '②：相手ターンに１度、このカードを除外できる。この効果で除外したこのカードは、相手ターンのエンドフェイズ時に自分フィールドに戻ってくる。',
      '③：このカードが戦闘で破壊された時、このカードのＳ召喚に使用した素材１組が自分の墓地に揃っている場合、それらを自分フィールドに特殊召喚できる。',
    ]),
    oppTurnSynchro: true,
  },
  {
    // ＴＧ ハルバード・キャノン：S召喚でしか特殊召喚できない（OCG版と同じ）
    onlyBy: 'synchro',
    ...anime(ocg('97836203'), [
      '①：このカードがフィールドに表側表示で存在する場合、モンスターの召喚・反転召喚・特殊召喚を無効にして破壊できる。この効果はこのカードのＳ召喚の素材としたモンスターの数だけ行う事ができる。',
      '②：このカードがフィールドを離れた時、エクストラデッキの「ＴＧ ブレード・ガンナー」１体を自分フィールドに特殊召喚できる。',
      '③：相手フィールドのモンスターがカードの効果によってフィールドを離れる場合、その効果を無効にしてそのモンスターの攻撃力を８００ダウンできる。',
    ]),
  },
  {
    ...SHOOTING_QUASAR,
    id: 'anime-35952884',
    variant: ANIME,
    attacksFromNonTuners: false,
    text: [
      SHOOTING_QUASAR.materialText!,
      'このカードはＳ召喚でしか特殊召喚できない。',
      '①：このカードは素材としたＳモンスターの数だけ攻撃できる。',
      '②：このカードが攻撃する時、「無効にする」という効果を持つフィールドのカード１枚の効果の発動を、バトルフェイズ終了時まで無効にできる。',
      '③：効果によるダメージを無効にする。',
      '④：このカードは相手モンスターのモンスター効果を受けない。',
      '⑤：このカードがフィールドを離れた時、フィールドのモンスターを全て破壊し、エクストラデッキの「シューティング・スター・ドラゴン」１体を自分フィールドに特殊召喚できる。この特殊召喚はＳ召喚扱いとする。',
    ].join('\n'),
  },
];
