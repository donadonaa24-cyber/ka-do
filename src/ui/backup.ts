import { CARD_BACK, type CardImages } from './cardImages';

// データの書き出し・読み込み：このブラウザに保存しているもの（デッキ・カード画像・加工・裏面・ルート・設定・続きのゲーム）を
// 1つのファイルにまとめ、別のページや別の端末に移す。

const APP = 'ygo-solo';
const VERSION = 1;
const IMG_PREFIX = 'ygo-solo:img:';
/** 書き出さないもの（通信対戦の部屋はページごと） */
const SKIP = new Set(['ygo-solo:pvp']);
/** 設定（ygo-solo: で始まらないもの） */
const SETTINGS = ['ygo-ore-rule', 'ygo-opp-mode', 'ygo-motion', 'ygo-sound'];

interface Backup {
  app: typeof APP;
  version: number;
  exportedAt: string;
  entries: Record<string, string>;
}

const isOurs = (key: string) => (key.startsWith('ygo-solo:') && !SKIP.has(key)) || SETTINGS.includes(key);

/** 非公開ページに最初から入っているカードの裏面（scripts/build-artifact.mjs） */
export const BUILTIN_BACK: string | undefined =
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { __BUILTIN_CARD_BACK__?: string }).__BUILTIN_CARD_BACK__;

export interface BackupSummary {
  decks: number;
  images: number;
  builtinImages: number;
  bytes: number;
}

/**
 * 書き出すファイルの中身。includeBuiltin なら、ページに最初から入っている画像（自分で変えていないもの）も入れる
 */
export function buildBackup(includeBuiltin: boolean, builtin: CardImages): { json: string; summary: BackupSummary } {
  const entries: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isOurs(key)) entries[key] = localStorage.getItem(key) ?? '';
    }
  } catch {
    // 読めない環境では空
  }
  let builtinImages = 0;
  if (includeBuiltin) {
    for (const [id, url] of Object.entries(builtin)) {
      if (entries[IMG_PREFIX + id]) continue;
      entries[IMG_PREFIX + id] = url;
      builtinImages++;
    }
    if (BUILTIN_BACK && !entries[IMG_PREFIX + CARD_BACK]) {
      entries[IMG_PREFIX + CARD_BACK] = BUILTIN_BACK;
      builtinImages++;
    }
  }
  const backup: Backup = { app: APP, version: VERSION, exportedAt: new Date().toISOString(), entries };
  const json = JSON.stringify(backup);
  let decks = 0;
  try {
    decks = (JSON.parse(entries['ygo-solo:decks'] ?? '[]') as unknown[]).length;
  } catch {
    // 数えられなくても書き出せる
  }
  return {
    json,
    summary: {
      decks,
      images: Object.keys(entries).filter((k) => k.startsWith(IMG_PREFIX)).length,
      builtinImages,
      bytes: new Blob([json]).size,
    },
  };
}

/** ファイルとして保存する（claude.ai のページでは保存の確認が出る） */
export async function saveBackupFile(json: string): Promise<'saved' | 'declined' | 'failed'> {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const filename = `yugioh-solo-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  const claude = (window as unknown as { claude?: { use(name: string): Promise<unknown> } }).claude;
  if (claude?.use) {
    try {
      const downloads = (await claude.use('downloads')) as {
        save(req: { filename: string; data: Blob }): Promise<unknown>;
      } | null;
      if (downloads) {
        try {
          await downloads.save({ filename, data: blob });
          return 'saved';
        } catch (e) {
          return (e as { code?: string })?.code === 'declined' ? 'declined' : 'failed';
        }
      }
    } catch {
      // 使えなければ普通のダウンロード
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'saved';
  } catch {
    return 'failed';
  }
}

export interface RestoreResult {
  written: number;
  failed: string[];
}

/** 配列（デッキ・ルート）は id か名前で、表（加工・デッキ名）は項目ごとに合わせる。読み込んだ方を優先 */
function merge(key: string, current: string | null, incoming: string): string {
  if (!current) return incoming;
  try {
    const a = JSON.parse(current) as unknown;
    const b = JSON.parse(incoming) as unknown;
    if (key === 'ygo-solo:decks' && Array.isArray(a) && Array.isArray(b)) {
      const ids = new Set(b.map((d: { id?: string }) => d.id));
      return JSON.stringify([...a.filter((d: { id?: string }) => !ids.has(d.id)), ...b]);
    }
    if (key === 'ygo-solo:routes' && Array.isArray(a) && Array.isArray(b)) {
      const names = new Set(b.map((r: { name?: string }) => r.name));
      return JSON.stringify([...a.filter((r: { name?: string }) => !names.has(r.name)), ...b]);
    }
    if ((key === 'ygo-solo:foil' || key === 'ygo-solo:deck-names') && a && b && typeof a === 'object') {
      return JSON.stringify({ ...(a as object), ...(b as object) });
    }
  } catch {
    // 合わせられなければ読み込んだ方
  }
  return incoming;
}

/** 読み込む（今のデータに足す。同じものは読み込んだ方にする） */
export function restoreBackup(text: string): RestoreResult | string {
  let backup: Backup;
  try {
    backup = JSON.parse(text) as Backup;
  } catch {
    return 'ファイルを読めませんでした（書き出したファイルを選んでください）';
  }
  if (backup?.app !== APP || typeof backup.entries !== 'object' || !backup.entries)
    return 'このシミュレーターで書き出したファイルではありません';
  const failed: string[] = [];
  let written = 0;
  // 画像は大きいので後に（容量が足りなくなっても、デッキや設定は先に入る）
  const keys = Object.keys(backup.entries)
    .filter(isOurs)
    .sort((x, y) => Number(x.startsWith(IMG_PREFIX)) - Number(y.startsWith(IMG_PREFIX)));
  for (const key of keys) {
    try {
      localStorage.setItem(key, merge(key, localStorage.getItem(key), backup.entries[key]));
      written++;
    } catch {
      failed.push(key);
    }
  }
  return { written, failed };
}
