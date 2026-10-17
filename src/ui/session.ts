import type { Action } from '../engine/game';

/** ゲームを再現するのに必要な情報（初期条件＋操作列） */
export interface SessionData {
  deckName: string;
  seed: number;
  fixedHand: string[];
  /** 初手の枚数（5=先攻、6=後攻）。古い保存データには無い */
  handSize?: 5 | 6;
  strict: boolean;
  actions: Action[];
}

export interface SavedRoute extends SessionData {
  name: string;
  savedAt: string;
}

const CURRENT_KEY = 'ygo-solo:current';
const ROUTES_KEY = 'ygo-solo:routes';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できない環境（プライベートモード等）では何もしない
  }
}

export const loadCurrent = () => read<SessionData>(CURRENT_KEY);
export const saveCurrent = (s: SessionData) => write(CURRENT_KEY, s);
export const loadRoutes = () => read<SavedRoute[]>(ROUTES_KEY) ?? [];
export const saveRoutes = (r: SavedRoute[]) => write(ROUTES_KEY, r);
