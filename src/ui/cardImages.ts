import { createContext } from 'react';

// 自分で読み込んだカード画像。ブラウザの中（localStorage）にだけ保存し、どこにも送らない。

const PREFIX = 'ygo-solo:img:';
/** 保存する画像の幅（px）。小さくして容量を抑える */
const WIDTH = 240;

export type CardImages = Record<string, string>;

export const CardImageContext = createContext<CardImages>({});

export function loadAllImages(): CardImages {
  const out: CardImages = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) out[key.slice(PREFIX.length)] = localStorage.getItem(key) ?? '';
    }
  } catch {
    // 保存できない環境（プライベートモード等）では画像なし
  }
  return out;
}

/** 保存できたら true（容量オーバーなどで失敗したら false） */
export function saveImage(cardId: string, dataUrl: string): boolean {
  try {
    localStorage.setItem(PREFIX + cardId, dataUrl);
    return true;
  } catch {
    return false;
  }
}

export function removeImage(cardId: string) {
  try {
    localStorage.removeItem(PREFIX + cardId);
  } catch {
    // 何もしない
  }
}

/** 画像ファイルを縮小してJPEGのdata URLにする */
export async function fileToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = Math.min(WIDTH, img.naturalWidth);
    const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}
