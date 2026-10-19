import type { LogEntry } from '../engine/types';

// 効果音：ブラウザの音声合成（Web Audio）でその場で作る（音声ファイルは使わない）。
// 召喚の種類・発動・チェーン・破壊・ダメージ・ドローなどで鳴らし分ける。

export type Sfx =
  | 'normal'
  | 'set'
  | 'special'
  | 'fusion'
  | 'synchro'
  | 'xyz'
  | 'link'
  | 'ritual'
  | 'activate'
  | 'chain'
  | 'destroy'
  | 'damage'
  | 'attack'
  | 'draw'
  | 'banish'
  | 'coin'
  | 'coinLand'
  | 'dice'
  | 'diceLand'
  | 'win';

const KEY = 'ygo-sound';

export interface SoundSettings {
  on: boolean;
  /** 0〜1 */
  volume: number;
}

export function loadSound(): SoundSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SoundSettings | null;
    if (v && typeof v.on === 'boolean' && typeof v.volume === 'number') return v;
  } catch {
    // 読めなければ既定
  }
  return { on: true, volume: 0.6 };
}

export function saveSound(s: SoundSettings) {
  settings = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても今の画面では使える
  }
}

let settings = loadSound();
let ac: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): { ac: AudioContext; out: GainNode } | null {
  if (!settings.on || settings.volume <= 0) return null;
  try {
    if (!ac) {
      const AC =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain();
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') void ac.resume();
    master!.gain.value = settings.volume * 0.5;
    return { ac, out: master! };
  } catch {
    return null;
  }
}

/** 最初の操作で音を出せるようにする（ブラウザは操作の前に音を出させない） */
export function unlockAudio() {
  if (settings.on) audio();
}

type Ctx = { ac: AudioContext; out: GainNode };

/** 音の高さが変わる音（波形・始まりと終わりの周波数・長さ） */
function tone(
  c: Ctx,
  at: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  dur: number,
  vol = 0.3,
  attack = 0.005,
) {
  const o = c.ac.createOscillator();
  const g = c.ac.createGain();
  o.type = type;
  const t = c.ac.currentTime + at;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let noiseBuf: AudioBuffer | null = null;
/** ザッという音（フィルターで音色を変える） */
function noise(c: Ctx, at: number, dur: number, filter: BiquadFilterType, f0: number, f1: number, vol = 0.3, q = 1) {
  if (!noiseBuf || noiseBuf.sampleRate !== c.ac.sampleRate) {
    noiseBuf = c.ac.createBuffer(1, c.ac.sampleRate, c.ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.ac.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bf = c.ac.createBiquadFilter();
  bf.type = filter;
  bf.Q.value = q;
  const g = c.ac.createGain();
  const t = c.ac.currentTime + at;
  bf.frequency.setValueAtTime(f0, t);
  bf.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bf).connect(g).connect(c.out);
  src.start(t);
  src.stop(t + dur + 0.02);
}

const SOUNDS: Record<Sfx, (c: Ctx, n: number) => void> = {
  // カードを置く「トン」
  normal: (c) => {
    noise(c, 0, 0.18, 'bandpass', 1800, 400, 0.35, 1.5);
    tone(c, 0, 'sine', 160, 70, 0.22, 0.45);
  },
  set: (c) => {
    noise(c, 0, 0.12, 'bandpass', 1200, 500, 0.25, 2);
    tone(c, 0, 'sine', 120, 60, 0.15, 0.3);
  },
  // 光が集まって現れる
  special: (c) => {
    noise(c, 0, 0.35, 'highpass', 900, 5000, 0.18, 0.7);
    tone(c, 0.02, 'triangle', 440, 1320, 0.35, 0.18, 0.05);
    tone(c, 0.3, 'sine', 180, 70, 0.3, 0.45);
  },
  // 渦を巻いて混ざり合う
  fusion: (c) => {
    for (let i = 0; i < 3; i++) tone(c, i * 0.04, 'sawtooth', 220 + i * 3, 660 + i * 7, 0.9, 0.06, 0.25);
    noise(c, 0, 0.9, 'bandpass', 400, 2400, 0.2, 4);
    tone(c, 0.95, 'sine', 200, 60, 0.45, 0.5);
    noise(c, 0.95, 0.4, 'lowpass', 3000, 200, 0.3);
  },
  // 光の輪を突き抜ける
  synchro: (c) => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(c, i * 0.09, 'triangle', f, f, 0.3, 0.15));
    noise(c, 0.4, 0.5, 'highpass', 2000, 9000, 0.25, 0.5);
    tone(c, 0.45, 'sawtooth', 300, 2400, 0.4, 0.1, 0.02);
    tone(c, 0.85, 'sine', 220, 70, 0.4, 0.45);
  },
  // 黒い靄から爆発
  xyz: (c) => {
    noise(c, 0, 0.9, 'lowpass', 300, 1200, 0.2, 2);
    tone(c, 0, 'sawtooth', 55, 110, 0.9, 0.12, 0.3);
    noise(c, 0.95, 0.7, 'lowpass', 5000, 150, 0.55);
    tone(c, 0.95, 'sine', 120, 35, 0.7, 0.6);
  },
  // 矢印が光る電子音
  link: (c) => {
    [880, 1175, 1568, 1175, 1760].forEach((f, i) => tone(c, i * 0.07, 'square', f, f, 0.07, 0.07));
    noise(c, 0.4, 0.3, 'bandpass', 3000, 6000, 0.15, 3);
    tone(c, 0.75, 'sine', 200, 60, 0.35, 0.45);
  },
  // 儀式の鐘
  ritual: (c) => {
    [196, 392, 588, 787].forEach((f, i) => tone(c, 0, 'sine', f, f * 0.995, 1.6 - i * 0.3, 0.2 / (i + 1), 0.01));
    noise(c, 0.6, 0.6, 'bandpass', 600, 2400, 0.12, 2);
    tone(c, 1.0, 'sine', 160, 50, 0.5, 0.45);
  },
  // カードの効果を発動する「シャキン」
  activate: (c) => {
    noise(c, 0, 0.25, 'highpass', 3000, 8000, 0.22, 0.8);
    tone(c, 0, 'triangle', 1200, 2400, 0.12, 0.15);
    tone(c, 0.06, 'sine', 1800, 1800, 0.35, 0.12);
  },
  // チェーン：番号が増えるほど高い音
  chain: (c, n) => {
    const base = 440 * Math.pow(2, (Math.min(n, 8) - 1) / 6);
    tone(c, 0, 'square', base, base, 0.08, 0.12);
    tone(c, 0.08, 'square', base * 1.5, base * 1.5, 0.16, 0.12);
    noise(c, 0, 0.2, 'highpass', 4000, 8000, 0.12);
  },
  destroy: (c) => {
    noise(c, 0, 0.45, 'lowpass', 6000, 300, 0.5);
    tone(c, 0, 'square', 300, 40, 0.35, 0.18);
    noise(c, 0.05, 0.3, 'bandpass', 2500, 800, 0.25, 3);
  },
  damage: (c) => {
    tone(c, 0, 'sine', 140, 40, 0.5, 0.6);
    noise(c, 0, 0.35, 'lowpass', 2000, 150, 0.4);
  },
  attack: (c) => {
    noise(c, 0, 0.3, 'bandpass', 600, 4000, 0.35, 1.5);
    tone(c, 0.18, 'sine', 180, 60, 0.3, 0.4);
  },
  draw: (c) => noise(c, 0, 0.16, 'bandpass', 2500, 5000, 0.25, 1.2),
  banish: (c) => {
    tone(c, 0, 'sine', 900, 200, 0.4, 0.15, 0.02);
    noise(c, 0, 0.4, 'highpass', 6000, 1500, 0.12);
  },
  coin: (c) => {
    for (let i = 0; i < 8; i++) tone(c, i * 0.09, 'triangle', 2600 + (i % 2) * 400, 2600 + (i % 2) * 400, 0.06, 0.08);
  },
  coinLand: (c) => {
    tone(c, 0, 'sine', 3200, 3150, 0.5, 0.15);
    tone(c, 0, 'sine', 4700, 4650, 0.35, 0.08);
  },
  dice: (c) => {
    for (let i = 0; i < 9; i++) noise(c, i * 0.08 + Math.random() * 0.03, 0.05, 'bandpass', 1500, 1200, 0.3, 4);
  },
  diceLand: (c) => noise(c, 0, 0.09, 'bandpass', 1100, 900, 0.4, 5),
  win: (c) => [523, 659, 784, 1047].forEach((f, i) => tone(c, i * 0.12, 'triangle', f, f, 0.4, 0.18)),
};

export function play(name: Sfx, n = 1, delay = 0) {
  const c = audio();
  if (!c) return;
  if (delay > 0) {
    window.setTimeout(() => play(name, n), delay);
    return;
  }
  try {
    SOUNDS[name](c, n);
  } catch {
    // 音が出せなくても遊べる
  }
}

/** ゲームのログ1行から、鳴らす効果音を決める */
export function sfxForLog(e: LogEntry): { name: Sfx; n?: number } | null {
  const t = e.text;
  const chain = t.match(/^チェーン(\d+)：/);
  if (chain) return { name: 'chain', n: Number(chain[1]) };
  if (e.kind === 'summon') {
    if (t.includes('融合召喚')) return { name: 'fusion' };
    if (t.includes('シンクロ召喚')) return { name: 'synchro' };
    if (t.includes('エクシーズ召喚')) return { name: 'xyz' };
    if (t.includes('リンク召喚')) return { name: 'link' };
    if (t.includes('儀式召喚')) return { name: 'ritual' };
    if (t.includes('セット')) return { name: 'set' };
    if (t.includes('特殊召喚')) return { name: 'special' };
    return { name: 'normal' };
  }
  if (t.includes('勝利')) return { name: 'win' };
  if (t.includes('ダメージ計算')) return { name: 'attack' };
  if (/ダメージ（|LP -/.test(t)) return { name: 'damage' };
  if (e.kind === 'activate') return { name: 'activate' };
  if (t.includes('破壊')) return { name: 'destroy' };
  if (e.kind === 'move' && /ドロー/.test(t)) return { name: 'draw' };
  if (e.kind === 'move' && /除外/.test(t)) return { name: 'banish' };
  if (e.kind === 'move' && /セット/.test(t)) return { name: 'set' };
  return null;
}
