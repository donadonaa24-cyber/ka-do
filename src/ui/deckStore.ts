import type { CardDef, DeckList } from '../engine/types';
import { isExtraDeckCard } from '../engine/types';

// 自分で作ったデッキ（最大10個）。ブラウザの中にだけ保存する。

export const MAX_DECKS = 10;
const KEY = 'ygo-solo:decks';

export interface SavedDeck extends DeckList {
  id: string;
  updatedAt: string;
}

export function loadDecks(): SavedDeck[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedDeck[]) : [];
    return Array.isArray(list) ? list.slice(0, MAX_DECKS) : [];
  } catch {
    return [];
  }
}

/** 保存できたら true */
export function saveDecks(decks: SavedDeck[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(decks.slice(0, MAX_DECKS)));
    return true;
  } catch {
    return false;
  }
}

export function newDeckId(): string {
  return `deck-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 他のデッキと名前が重ならないようにする（ゲームの記録はデッキ名で覚えているため） */
export function uniqueName(name: string, taken: string[]): string {
  const base = name.trim() || '新しいデッキ';
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}（${i}）`)) return `${base}（${i}）`;
}

/** デッキの構築ルールの違反（空なら問題なし） */
export function deckProblems(deck: DeckList, db: Record<string, CardDef>): string[] {
  const out: string[] = [];
  if (deck.main.length < 40) out.push(`メインデッキが${deck.main.length}枚です（40枚以上必要）`);
  if (deck.main.length > 60) out.push(`メインデッキが${deck.main.length}枚です（60枚まで）`);
  if (deck.extra.length > 15) out.push(`EXデッキが${deck.extra.length}枚です（15枚まで）`);
  if ((deck.side?.length ?? 0) > 15) out.push(`サイドデッキが${deck.side!.length}枚です（15枚まで）`);
  const counts = new Map<string, number>();
  for (const id of [...deck.main, ...deck.extra, ...(deck.side ?? [])]) {
    const name = db[id]?.name ?? id;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, n] of counts) if (n > 3) out.push(`${name}が${n}枚です（同じカードは3枚まで）`);
  if (deck.main.some((id) => db[id] && isExtraDeckCard(db[id]))) out.push('メインデッキにEXデッキのカードが入っています');
  if (deck.extra.some((id) => db[id] && !isExtraDeckCard(db[id]))) out.push('EXデッキにメインデッキのカードが入っています');
  return out;
}
