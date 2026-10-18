import type { CardDef, GameState, LinkMarker } from './types';

// ===== 盤面の座標 =====
// 列 0-4、行 0=EXモンスターゾーン / 1=メインモンスターゾーン / 2=魔法＆罠ゾーン
// EXモンスターゾーンは 0 → 列1、1 → 列3

export const EMZ_COLUMN = [1, 3];

const MARKER_DELTA: Record<LinkMarker, [number, number]> = {
  TL: [-1, -1],
  T: [-1, 0],
  TR: [-1, 1],
  L: [0, -1],
  R: [0, 1],
  BL: [1, -1],
  B: [1, 0],
  BR: [1, 1],
};

export const MARKER_ARROW: Record<LinkMarker, string> = {
  TL: '↖',
  T: '↑',
  TR: '↗',
  L: '←',
  R: '→',
  BL: '↙',
  B: '↓',
  BR: '↘',
};

/** そのリンクモンスターのリンク先となっているメインモンスターゾーンの番号 */
export function linkedZonesOf(state: GameState, uid: string, def: CardDef): number[] {
  const inst = state.cards[uid];
  if (!inst?.faceUp || def.frame !== 'link' || !def.linkMarkers) return [];
  const mz = state.mz.indexOf(uid);
  const ez = state.emz.indexOf(uid);
  if (mz < 0 && ez < 0) return [];
  const [row, col] = mz >= 0 ? [1, mz] : [0, EMZ_COLUMN[ez]];
  const out: number[] = [];
  for (const m of def.linkMarkers) {
    const [dr, dc] = MARKER_DELTA[m];
    if (row + dr === 1 && col + dc >= 0 && col + dc <= 4) out.push(col + dc);
  }
  return out;
}

/** 自分のリンクモンスターのリンク先となっているメインモンスターゾーンの番号 */
export function linkedMainZones(state: GameState, getDef: (uid: string) => CardDef): Set<number> {
  const result = new Set<number>();
  for (const uid of [...state.mz, ...state.emz]) {
    if (uid) for (const c of linkedZonesOf(state, uid, getDef(uid))) result.add(c);
  }
  return result;
}

// ===== 召喚条件 =====

/** アドバンス召喚に必要なリリース数 */
export function tributesRequired(level: number): number {
  if (level >= 7) return 2;
  if (level >= 5) return 1;
  return 0;
}

/**
 * リンク素材の合計がリンクマーカー数ちょうどにできるか。
 * リンクモンスターを素材にする場合は「1」または「そのリンクマーカー数」として数えられる。
 */
export function canMakeLinkRating(materialValues: number[][], target: number): boolean {
  let sums = new Set<number>([0]);
  for (const options of materialValues) {
    const next = new Set<number>();
    for (const s of sums) for (const v of options) if (s + v <= target) next.add(s + v);
    sums = next;
  }
  return sums.has(target);
}

export function linkMaterialOptions(def: CardDef): number[] {
  if (def.frame === 'link' && def.link && def.link > 1) return [1, def.link];
  return [1];
}

/** モンスターの現在のレベル（エクシーズ・リンクはレベルを持たない） */
export function levelOf(def: CardDef): number | undefined {
  if (def.frame === 'xyz' || def.frame === 'link') return undefined;
  return def.level;
}
