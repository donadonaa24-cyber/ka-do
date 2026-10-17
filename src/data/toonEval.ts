import { type Ctx, fieldMonsters, getDef, makeEnv } from '../engine/game';
import type { Evaluator } from '../engine/solver';
import type { GameState } from '../engine/types';

// トゥーンデッキの盤面評価。相手ターンに使える妨害を重く、展開に使い切った資源は軽く見る。

/** 場に表側で残ったモンスターの妨害・価値 */
const MONSTER_VALUE: Record<string, { value: number; note?: string; needsWorld?: boolean }> = {
  'トゥーン・カオス・ソルジャー': { value: 3, note: '除外（相手ターンは不可・自分ターンの除去）', needsWorld: true },
  '超魔導竜騎士－ドラグーン・オブ・レッドアイズ': { value: 5, note: '発動無効（手札1枚コスト）' },
  '光なき影 ア＝バオ・ア・クゥー': { value: 4, note: '相手メインフェイズに破壊' },
  'Ｓ：Ｐリトルナイト': { value: 4, note: '相手の効果に対して2体除外' },
  '厄災の星ティ・フォン': { value: 3, note: 'バウンス・攻撃力3000以上の効果を封じる' },
  'コミックキャット': { value: 3, note: '相手メインフェイズにリリースして特殊召喚', needsWorld: true },
  'エビル・ボックス': { value: 2, note: '相手ターンに墓地のカードをデッキの下へ' },
  'Ｉ：Ｐマスカレーナ': { value: 2, note: '相手ターンにリンク召喚' },
  'ブルーアイズ・トゥーン・アルティメットドラゴン': { value: 3, note: '攻撃4500・トゥーンを守る' },
  '神聖魔皇后セレーネ': { value: 1.5 },
  '神書の使いラハムゥ': { value: 1 },
  'ブルーアイズ・トゥーン・ドラゴン': { value: 1.5 },
  'トゥーン・ブラック・マジシャン': { value: 1.5 },
  'トゥーン・ブラック・マジシャン・ガール': { value: 1 },
};

/** 伏せた罠・表の永続カード */
const TRAP_VALUE: Record<string, { value: number; note: string; needsToon?: boolean }> = {
  'トゥーン・テラー': { value: 5, note: '発動無効（カウンター罠）', needsToon: true },
  '無限泡影': { value: 3, note: 'モンスター効果無効' },
  '霆王の閃光': { value: 3, note: 'モンスター除外' },
  'トゥーンのかばん': { value: 2, note: '召喚されたモンスターをデッキへ', needsToon: true },
  'センサー万別': { value: 1.5, note: '同じ種族を1体に制限' },
};

const HAND_VALUE: Record<string, number> = {
  '灰流うらら': 2,
  '増殖するＧ': 1.5,
  'ドロール＆ロックバード': 1.5,
  '幽鬼うさぎ': 1.5,
  '無限泡影': 1,
};

function analyze(state: GameState, ctx: Ctx) {
  const def = (u: string) => getDef(state, ctx, u);
  const env = makeEnv(state, ctx, '');
  const toonOnField = fieldMonsters(state).some((u) => state.cards[u].faceUp && env.isToon(u));
  let score = 0;
  const notes: string[] = [];

  if (env.toonWorld) {
    score += 2;
    notes.push(`フィールド：${def(state.fz!).name}`);
  }
  for (const u of fieldMonsters(state)) {
    const d = def(u);
    const v = MONSTER_VALUE[d.name];
    const active = !v?.needsWorld || env.toonWorld;
    score += 0.5 + (d.atk ?? 0) / 2000 + (v && active ? v.value : 0);
    notes.push(`モンスター：${d.name}${v?.note && active ? `（${v.note}）` : ''}`);
  }
  for (const u of state.stz) {
    if (!u) continue;
    const d = def(u);
    const inst = state.cards[u];
    if (!inst.faceUp && d.kind === 'trap') {
      const v = TRAP_VALUE[d.name];
      const works = v && (!v.needsToon || (env.toonWorld && toonOnField));
      score += works ? v.value : 0.5;
      notes.push(`伏せ：${d.name}${works ? `（${v.note}）` : ''}`);
    } else if (inst.faceUp && d.name === '心を見通す眼') {
      score += 3;
      notes.push('表側：心を見通す眼（カード名を宣言して無効）');
    } else {
      score += 0.3;
      notes.push(`魔法＆罠ゾーン：${d.name}`);
    }
  }
  const handTraps = state.hand.filter((u) => HAND_VALUE[def(u).name]);
  for (const u of state.hand) score += HAND_VALUE[def(u).name] ?? 0.3;
  if (handTraps.length) notes.push(`手札誘発：${handTraps.map((u) => def(u).name).join('、')}`);
  notes.push(`手札 ${state.hand.length}枚`);
  return { score, notes };
}

export const TOON_EVALUATOR: Evaluator = {
  score: (state, ctx) => analyze(state, ctx).score,
  describe: (state, ctx) => analyze(state, ctx).notes,
};
