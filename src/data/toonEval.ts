import { type Ctx, fieldMonsters, getDef, makeEnv } from '../engine/game';
import type { Evaluator } from '../engine/solver';
import type { GameState } from '../engine/types';

// トゥーンデッキの盤面評価。相手ターンに使える妨害を重く、展開に使い切った資源は軽く見る。

/** 場に表側で残ったモンスターの妨害・価値 */
const MONSTER_VALUE: Record<string, { value: number; note?: string; needsWorld?: boolean }> = {
  'トゥーン・カオス・ソルジャー': { value: 3, note: '次の自分ターンにフィールドのカード1枚を除外', needsWorld: true },
  '超魔導竜騎士－ドラグーン・オブ・レッドアイズ': {
    value: 5,
    note: '相手の効果の発動にチェーンし、手札1枚を捨てて無効＆破壊',
  },
  '光なき影 ア＝バオ・ア・クゥー': { value: 4, note: '相手メインフェイズに手札1枚を捨ててカード1枚を破壊' },
  'Ｓ：Ｐリトルナイト': { value: 4, note: '相手の効果の発動にチェーンして表側モンスター2体を除外' },
  '厄災の星ティ・フォン': { value: 3, note: '相手モンスター1体を手札へ。攻撃力3000以上の効果を封じる' },
  コミックキャット: { value: 3, note: '相手メインフェイズに相手モンスターをリリースして特殊召喚', needsWorld: true },
  'エビル・ボックス': { value: 2, note: '相手の墓地効果にチェーンしてそのカードをデッキの下へ' },
  'Ｉ：Ｐマスカレーナ': { value: 2, note: '相手メインフェイズにリンク召喚して妨害を増やす' },
  'ブルーアイズ・トゥーン・アルティメットドラゴン': { value: 3, note: '攻撃4500・トゥーンを守る' },
  'フルール・ド・バロネス': { value: 5, note: '相手の効果の発動にチェーンして無効＆破壊' },
  'ドラグニティロード－ゲオルギアス': { value: 3, note: '装備カードを墓地へ送り、相手の魔法・罠の効果を無効' },
  'ヴァレルロード・Ｓ・ドラゴン': { value: 3, note: 'ヴァレルカウンターを使って相手の効果の発動を無効' },
  精霊コロゾ: { value: 2, note: '攻撃宣言時にその攻撃を無効' },
  神聖魔皇后セレーネ: { value: 1.5 },
  神書の使いラハムゥ: { value: 1 },
  'ブルーアイズ・トゥーン・ドラゴン': { value: 1.5 },
  'トゥーン・ブラック・マジシャン': { value: 1.5 },
  'トゥーン・ブラック・マジシャン・ガール': { value: 1 },
};

/** 伏せた罠・表の永続カード */
const TRAP_VALUE: Record<string, { value: number; note: string; needsToon?: boolean }> = {
  'トゥーン・テラー': { value: 5, note: '相手の効果・魔法・罠の発動にチェーンして無効＆破壊', needsToon: true },
  無限泡影: { value: 3, note: '相手の効果モンスターにチェーンして効果を無効' },
  霆王の閃光: { value: 3, note: '相手モンスター1体を除外' },
  トゥーンのかばん: { value: 2, note: '相手がモンスターを召喚・特殊召喚した時にデッキへ戻す', needsToon: true },
  センサー万別: { value: 1.5, note: '同じ種族を1体に制限して展開を止める' },
  '聖なる心のバリア －マインドフォース－': {
    value: 3,
    note: '相手の自分ターン中の手札・場のモンスター効果やカード破壊効果にチェーンして、相手の表側カードを全て無効＆破壊',
  },
};

const HAND_VALUE: Record<string, number> = {
  灰流うらら: 2,
  増殖するＧ: 1.5,
  'ドロール＆ロックバード': 1.5,
  幽鬼うさぎ: 1.5,
  無限泡影: 1,
  'マルチャミー・フワロス': 1.5,
  霊王の波動: 2,
  'ＰＳＹフレームギア・γ': 1.5,
  'ＰＳＹフレームギア・δ': 1,
};

/** 手札誘発をいつ使うか */
const HAND_USE: Record<string, string> = {
  灰流うらら: '相手のサーチ・デッキからの特殊召喚・墓地送りにチェーンして無効',
  増殖するＧ: '相手が展開を始めたら発動し、特殊召喚のたびにドロー',
  'ドロール＆ロックバード': '相手がドロー以外でデッキから手札に加えた後に発動',
  幽鬼うさぎ: '相手の場のモンスター効果の発動にチェーンして破壊',
  無限泡影: '自分の場にカードが無ければ手札から、相手の効果モンスターを無効',
  'マルチャミー・フワロス': '自分の場にカードが無い時に捨てて、相手がデッキ・EXから特殊召喚するたびにドロー',
  霊王の波動: '相手の特殊召喚を含む効果にチェーンして無効（相手の場にカードがあれば手札から）',
  'ＰＳＹフレームギア・γ': '自分の場にモンスターがいない時、相手のモンスター効果にチェーンして無効＆破壊',
  'ＰＳＹフレームギア・δ': '自分の場にモンスターがいない時、相手の魔法の発動にチェーンして無効＆破壊',
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
  // 自身の効果でエンドフェイズまで除外したモンスターは相手ターンには戻っている
  for (const u of state.banished) {
    const d = def(u);
    const v = MONSTER_VALUE[d.name];
    if (d.name !== '光なき影 ア＝バオ・ア・クゥー' || !v) continue;
    score += 0.5 + (d.atk ?? 0) / 2000 + v.value;
    notes.push(`モンスター：${d.name}（エンドフェイズに戻る。${v.note}）`);
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
      notes.push('表側：心を見通す眼（相手の初動にチェーンしてカード名を宣言し、その効果を無効）');
    } else {
      score += 0.3;
      notes.push(`魔法＆罠ゾーン：${d.name}`);
    }
  }
  for (const u of state.hand) score += HAND_VALUE[def(u).name] ?? 0.3;
  for (const name of new Set(state.hand.map((u) => def(u).name))) {
    if (HAND_USE[name]) notes.push(`手札：${name}（${HAND_USE[name]}）`);
  }
  notes.push(`手札 ${state.hand.length}枚`);
  return { score, notes };
}

export const TOON_EVALUATOR: Evaluator = {
  score: (state, ctx) => analyze(state, ctx).score,
  describe: (state, ctx) => analyze(state, ctx).notes,
};
