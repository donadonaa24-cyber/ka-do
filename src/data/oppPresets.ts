import type { Action } from '../engine/game';
import type { GameState } from '../engine/types';
import { ALL_CARDS } from '.';

// 相手の盤面のプリセット（相手がトゥーンの最終盤面）。置いたカードの妨害は相手AIがチェーンして使ってくる（engine/oppAI.ts）

const idOf = (name: string) => {
  const d = ALL_CARDS.find((c) => c.name === name);
  if (!d) throw new Error(`カードがありません: ${name}`);
  return d.id;
};

type Place = Extract<Action, { type: 'OPP_PLACE' }>;
const mon = (name: string, index: number, position: 'atk' | 'def' = 'atk'): Omit<Place, 'type'> => ({
  defId: idOf(name),
  to: { zone: 'omz', index },
  faceUp: true,
  position,
});
const st = (name: string, index: number, faceUp: boolean): Omit<Place, 'type'> => ({
  defId: idOf(name),
  to: { zone: 'ostz', index },
  faceUp,
});

export interface OppPreset {
  id: string;
  name: string;
  description: string;
  cards: () => Omit<Place, 'type'>[];
}

/** トゥーンの土台：完全なる世界＋BTUD（トゥーン・テラーの条件） */
const base = () => [
  { defId: idOf('完全なる世界 トゥーン・ワールド'), to: { zone: 'ofz' } as const, faceUp: true },
  mon('ブルーアイズ・トゥーン・アルティメットドラゴン', 2),
];

export const OPP_PRESETS: OppPreset[] = [
  {
    id: 'toon-1',
    name: '1妨害',
    description: 'フルール・ド・バロネス（発動を無効にし破壊・1度だけ）',
    cards: () => [...base(), mon('フルール・ド・バロネス', 1)],
  },
  {
    id: 'toon-2',
    name: '2妨害',
    description: 'バロネス＋伏せトゥーン・テラー（発動を無効にし破壊）',
    cards: () => [...base(), mon('フルール・ド・バロネス', 1), st('トゥーン・テラー', 2, false)],
  },
  {
    id: 'toon-3',
    name: '3妨害',
    description: 'バロネス＋トゥーン・テラー＋ア＝バオ・ア・クゥー（手札1枚を捨ててカード1枚を破壊）',
    cards: () => [
      ...base(),
      mon('フルール・ド・バロネス', 1),
      mon('光なき影 ア＝バオ・ア・クゥー', 3),
      st('トゥーン・テラー', 2, false),
      { defId: 'opp-monster', to: { zone: 'ohand' }, faceUp: false },
    ],
  },
  {
    id: 'toon-4',
    name: '4妨害',
    description:
      '記事の最終盤面：バロネス＋トゥーン・テラー＋ア＝バオ・ア・クゥー＋ゲオルギアス③（ハールーン装備・魔法・罠の効果を無効）＋心を見通す眼',
    cards: () => [
      ...base(),
      mon('ドラグニティロード－ゲオルギアス', 0),
      mon('フルール・ド・バロネス', 1),
      mon('光なき影 ア＝バオ・ア・クゥー', 3),
      st('ドラグニティナイト－ハールーン', 1, true),
      st('トゥーン・テラー', 2, false),
      st('心を見通す眼', 3, true),
      { defId: 'opp-monster', to: { zone: 'ohand' }, faceUp: false },
    ],
  },
];

/** 今の相手のカードを全部取り除いて、プリセットの盤面を置く操作 */
export function oppPresetAction(state: GameState, preset: OppPreset | null): Action {
  const o = state.opp;
  const current = o ? [...o.mz, ...o.stz, o.fz, ...o.gy, ...o.banished, ...o.hand].filter((u): u is string => !!u) : [];
  return {
    type: 'BATCH',
    label: preset ? `（練習）相手の盤面：${preset.name}` : '（練習）相手の盤面を片付ける',
    actions: [
      ...current.map((uid) => ({ type: 'OPP_REMOVE', uid }) as Action),
      ...(preset?.cards() ?? []).map((c) => ({ type: 'OPP_PLACE', ...c }) as Action),
    ],
  };
}
