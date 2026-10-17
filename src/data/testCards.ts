import type { CardDef, DeckList } from '../engine/types';

/**
 * 動作確認用の架空カード。
 * 実際のデッキ（gachi-matome のレシピ）のカードは cards/ 以下に追加していく。
 */
export const TEST_CARDS: CardDef[] = [
  { id: 't-lv4-a', name: 'テスト戦士A', kind: 'monster', frame: 'effect', attribute: '地', race: '戦士族', level: 4, atk: 1800, def: 1200, text: '（テスト用）召喚・特殊召喚時に効果を発動できる想定。' },
  { id: 't-lv4-b', name: 'テスト魔法使いB', kind: 'monster', frame: 'normal', attribute: '闇', race: '魔法使い族', level: 4, atk: 1600, def: 1000, text: '（テスト用）通常モンスター。' },
  { id: 't-tuner3', name: 'テストチューナー', kind: 'monster', frame: 'effect', attribute: '光', race: '機械族', level: 3, atk: 1300, def: 800, tuner: true, text: '（テスト用）チューナー。' },
  { id: 't-lv7', name: 'テストドラゴン', kind: 'monster', frame: 'normal', attribute: '光', race: 'ドラゴン族', level: 7, atk: 2500, def: 2000, text: '（テスト用）リリース2体で召喚。' },
  { id: 't-lv6', name: 'テスト悪魔', kind: 'monster', frame: 'effect', attribute: '闇', race: '悪魔族', level: 6, atk: 2300, def: 1500, text: '（テスト用）リリース1体で召喚。' },
  { id: 't-ritual', name: 'テスト儀式モンスター', kind: 'monster', frame: 'ritual', attribute: '水', race: '戦士族', level: 6, atk: 2600, def: 2000, text: '（テスト用）「テスト儀式」により降臨。' },
  { id: 't-spell-search', name: 'テストサーチ', kind: 'spell', spellType: 'normal', text: '（テスト用）デッキからモンスター1体を手札に加える。' },
  { id: 't-spell-quick', name: 'テスト速攻魔法', kind: 'spell', spellType: 'quick', text: '（テスト用）速攻魔法。' },
  { id: 't-spell-field', name: 'テストフィールド', kind: 'spell', spellType: 'field', text: '（テスト用）フィールド魔法。' },
  { id: 't-spell-ritual', name: 'テスト儀式', kind: 'spell', spellType: 'ritual', text: '（テスト用）レベル合計が6以上になるようにリリースし、儀式モンスターを儀式召喚する。' },
  { id: 't-trap', name: 'テスト罠', kind: 'trap', trapType: 'normal', text: '（テスト用）通常罠。' },
  // --- EXデッキ ---
  { id: 't-fusion', name: 'テスト融合体', kind: 'monster', frame: 'fusion', attribute: '闇', race: '魔法使い族', level: 8, atk: 2800, def: 2300, fusionMaterialCount: 2, materialText: 'モンスター×2', text: '（テスト用）' },
  { id: 't-synchro7', name: 'テストシンクロ', kind: 'monster', frame: 'synchro', attribute: '光', race: 'ドラゴン族', level: 7, atk: 2500, def: 2000, materialText: 'チューナー＋チューナー以外のモンスター1体以上', text: '（テスト用）' },
  { id: 't-xyz4', name: 'テストエクシーズ', kind: 'monster', frame: 'xyz', attribute: '地', race: '戦士族', rank: 4, atk: 2200, def: 1800, xyzMaterialCount: 2, materialText: 'レベル4モンスター×2', text: '（テスト用）' },
  { id: 't-link2', name: 'テストリンク2', kind: 'monster', frame: 'link', attribute: '闇', race: 'サイバース族', link: 2, linkMarkers: ['BL', 'BR'], atk: 1500, materialText: 'モンスター2体', text: '（テスト用）' },
  { id: 't-link1', name: 'テストリンク1', kind: 'monster', frame: 'link', attribute: '光', race: 'サイバース族', link: 1, linkMarkers: ['B'], atk: 800, materialText: 'モンスター1体', text: '（テスト用）' },
  { id: 't-link3', name: 'テストリンク3', kind: 'monster', frame: 'link', attribute: '闇', race: 'サイバース族', link: 3, linkMarkers: ['L', 'R', 'B'], atk: 2300, materialText: '効果モンスター2体以上', text: '（テスト用）' },
];

const n = (id: string, count: number) => Array<string>(count).fill(id);

export const TEST_DECK: DeckList = {
  name: 'テスト用デッキ',
  main: [
    ...n('t-lv4-a', 6),
    ...n('t-lv4-b', 6),
    ...n('t-tuner3', 4),
    ...n('t-lv7', 2),
    ...n('t-lv6', 2),
    ...n('t-ritual', 2),
    ...n('t-spell-search', 3),
    ...n('t-spell-quick', 3),
    ...n('t-spell-field', 2),
    ...n('t-spell-ritual', 2),
    ...n('t-trap', 8),
  ],
  extra: [...n('t-fusion', 2), ...n('t-synchro7', 2), ...n('t-xyz4', 2), ...n('t-link2', 3), ...n('t-link1', 2), ...n('t-link3', 2)],
};
