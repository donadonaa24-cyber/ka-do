import type { CardDef, DeckList } from '../engine/types';
import { TEST_CARDS, TEST_DECK } from './testCards';

export const ALL_CARDS: CardDef[] = [...TEST_CARDS];

export const CARD_DB: Record<string, CardDef> = Object.fromEntries(ALL_CARDS.map((c) => [c.id, c]));

export const DECKS: DeckList[] = [TEST_DECK];
