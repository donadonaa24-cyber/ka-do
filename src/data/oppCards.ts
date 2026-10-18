import type { CardDef } from '../engine/types';

/** 練習用に相手の盤面に置く、名前の決まっていないカード（効果は持たない） */
export const OPP_GENERIC_CARDS: CardDef[] = [
  {
    id: 'opp-monster',
    name: '相手のモンスター',
    kind: 'monster',
    frame: 'effect',
    level: 4,
    atk: 2000,
    def: 1000,
    text: '（練習用）相手の効果モンスター。',
  },
  {
    id: 'opp-extra-monster',
    name: '相手のEXモンスター',
    kind: 'monster',
    frame: 'link',
    link: 2,
    atk: 2000,
    text: '（練習用）相手のエクストラデッキのモンスター。',
  },
  { id: 'opp-spell', name: '相手の魔法', kind: 'spell', spellType: 'continuous', text: '（練習用）相手の魔法カード。' },
  {
    id: 'opp-trap',
    name: '相手の罠',
    kind: 'trap',
    trapType: 'normal',
    text: '（練習用）相手の罠カード（伏せカードなど）。',
  },
  {
    id: 'opp-field',
    name: '相手のフィールド魔法',
    kind: 'spell',
    spellType: 'field',
    text: '（練習用）相手のフィールド魔法。',
  },
];
