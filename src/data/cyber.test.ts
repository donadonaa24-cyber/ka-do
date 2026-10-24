import { describe, expect, it } from 'vitest';
import {
  afterPick,
  completeStep,
  type RunResult,
  type Running,
  startEffect,
  stepCandidates,
} from '../engine/effectRunner';
import {
  type Action,
  applyAction,
  createGame,
  type Ctx,
  currentLevel,
  currentStats,
  type MonsterLocation,
} from '../engine/game';
import type { GameState, Location } from '../engine/types';
import { deckProblems } from '../ui/deckStore';
import { CARD_DB, CARD_SCRIPTS, CYBER_DRAGON_DECK } from '.';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const name = (s: GameState, u: string) => CARD_DB[s.cards[u].defId]?.name ?? s.tokenDefs?.[s.cards[u].defId]?.name;
const find = (s: GameState, zone: 'deck' | 'gy' | 'extra' | 'hand' | 'banished', n: string) =>
  s[zone].find((u) => name(s, u) === n)!;
const mz = (index: number): MonsterLocation => ({ zone: 'mz', index });

function act(s: GameState, a: Action): GameState {
  const r = applyAction(s, a, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}
/** カードを場所に置く（テストの準備用） */
const put = (s: GameState, uid: string, index: number) => act(s, { type: 'SPECIAL_SUMMON', uid, to: mz(index) });
const toZone = (s: GameState, uid: string, zone: 'hand' | 'gy') => act(s, { type: 'MOVE', uid, to: { zone } });

/** 効果を発動し、choices の順に選んで最後まで処理する。失敗したらエラー文を返す */
function tryEffect(
  s: GameState,
  uid: string,
  label: string,
  choices: { pick?: string[]; zone?: Location; mode?: number }[] = [],
): GameState | string {
  const effect = CARD_SCRIPTS[s.cards[uid].defId].effects!.find((e) => e.label.includes(label));
  if (!effect) throw new Error(`効果がありません: ${label}`);
  let r: RunResult = startEffect(s, ctx, uid, effect);
  for (const c of choices) {
    if (r.kind !== 'running') break;
    const run: Running = r.run;
    if (c.pick) {
      const cands = stepCandidates(run, ctx);
      const picked: string[] = [];
      for (const n of c.pick) {
        const u = cands.find((x) => name(run.temp, x) === n && !picked.includes(x));
        if (!u) throw new Error(`候補にありません: ${n}（候補: ${cands.map((x) => name(run.temp, x)).join('、')}）`);
        picked.push(u);
      }
      r = afterPick({ ...run, picked }, ctx);
      if (r.kind === 'running' && c.mode !== undefined) r = afterPick({ ...r.run, mode: c.mode }, ctx);
      if (r.kind === 'running' && r.run.stage === 'zone' && c.zone) r = completeStep(r.run, ctx, c.zone);
    } else if (c.zone) {
      r = completeStep(run, ctx, c.zone);
    }
  }
  if (r.kind === 'error') return r.error;
  if (r.kind === 'running') throw new Error(`効果処理が終わっていません（step ${r.run.stepIndex}）`);
  const done = applyAction(s, r.action, ctx);
  return done.ok ? done.state : done.error;
}
function useEffect(...args: Parameters<typeof tryEffect>): GameState {
  const r = tryEffect(...args);
  if (typeof r === 'string') throw new Error(r);
  return r;
}

describe('サイバー・ドラゴン', () => {
  const DECK = CYBER_DRAGON_DECK;
  const game = () => createGame(DECK, ctx, 1, []);

  it('デッキはメイン40枚・EX15枚で登録できる', () => {
    expect(DECK.main).toHaveLength(40);
    expect(DECK.extra).toHaveLength(15);
    expect(deckProblems(DECK, CARD_DB)).toEqual([]);
  });

  it('パワー・ボンド：「サイバー・ドラゴン」モンスター2体でランページを融合召喚し、攻撃力が倍・エンドフェイズにダメージ', () => {
    let s = game();
    s = toZone(s, find(s, 'deck', 'パワー・ボンド'), 'hand');
    s = put(s, find(s, 'deck', 'サイバー・ドラゴン'), 0);
    s = put(s, find(s, 'deck', 'サイバー・ドラゴン・コア'), 1);
    s = useEffect(s, find(s, 'hand', 'パワー・ボンド'), '発動', [
      { pick: ['キメラテック・ランページ・ドラゴン'] },
      { pick: ['サイバー・ドラゴン', 'サイバー・ドラゴン・コア'], zone: mz(2) },
    ]);
    const rampage = s.mz[2]!;
    expect(name(s, rampage)).toBe('キメラテック・ランページ・ドラゴン');
    expect(currentStats(s, ctx, rampage).atk).toBe(4200);
    s = act(s, { type: 'NEXT_PHASE', to: 'EP' });
    expect(s.lp).toBe(8000 - 2100);
  });

  it('未来融合ノヴァ：デッキの「サイバー・ドラゴン」を含む3体でサイバー・エンドを融合召喚し、①で4000払ってリミッター解除', () => {
    let s = game();
    s = toZone(s, find(s, 'deck', '未来融合－フューチャー・フュージョン・ノヴァ'), 'hand');
    s = useEffect(s, find(s, 'hand', '未来融合－フューチャー・フュージョン・ノヴァ'), '発動', [
      { pick: ['終撃竜－サイバー・エンド・ドラゴン'] },
      { pick: ['サイバー・ドラゴン', '機光竜－サイバー・ドラゴン', '壊星壊獣ジズキエル'], zone: mz(2) },
    ]);
    const end = s.mz[2]!;
    expect(name(s, end)).toBe('終撃竜－サイバー・エンド・ドラゴン');
    s = useEffect(s, end, '① 光属性だけで融合召喚', [{ pick: ['リミッター解除'] }]);
    expect(s.lp).toBe(4000);
    expect(s.hand.map((u) => name(s, u))).toContain('リミッター解除');
    // このターンは機械族しか特殊召喚できない
    expect(applyAction(s, { type: 'SPECIAL_SUMMON', uid: find(s, 'deck', '灰流うらら'), to: mz(0) }, ctx).ok).toBe(
      false,
    );
  });

  it('サイバー・ドラゴン・ヘルツ：特殊召喚するとレベル5、墓地へ送られると「サイバー・ドラゴン」をサーチ', () => {
    let s = game();
    s = put(s, find(s, 'deck', 'サイバー・ドラゴン・ヘルツ'), 0);
    const herz = s.mz[0]!;
    s = useEffect(s, herz, '② 特殊召喚した場合');
    expect(currentLevel(s, ctx, herz)).toBe(5);
    s = act(s, { type: 'END_TURN', toOpponent: true });
    s = act(s, { type: 'MOVE', uid: herz, to: { zone: 'gy' } });
    s = useEffect(s, herz, '③ 墓地へ送られた場合', [{ pick: ['サイバー・ドラゴン'] }]);
    expect(s.hand.map((u) => name(s, u))).toContain('サイバー・ドラゴン');
  });

  it('ノヴァの上に重ねてインフィニティをX召喚：素材の数×200アップ', () => {
    let s = game();
    s = put(s, find(s, 'deck', 'サイバー・ドラゴン'), 0);
    s = put(s, find(s, 'deck', '機光竜－サイバー・ドラゴン'), 1);
    s = act(s, {
      type: 'PROCEDURE_SUMMON',
      method: 'xyz',
      uid: find(s, 'extra', 'サイバー・ドラゴン・ノヴァ'),
      materials: [s.mz[0]!, s.mz[1]!],
      to: { zone: 'emz', index: 0 },
    });
    const nova = s.emz[0]!;
    s = act(s, {
      type: 'PROC_SUMMON',
      uid: find(s, 'extra', 'サイバー・ドラゴン・インフィニティ'),
      proc: 0,
      materials: [nova],
      to: { zone: 'emz', index: 0 },
    });
    const inf = s.emz[0]!;
    expect(name(s, inf)).toBe('サイバー・ドラゴン・インフィニティ');
    expect(s.cards[inf].overlay).toHaveLength(3);
    expect(currentStats(s, ctx, inf).atk).toBe(2100 + 600);
  });

  it('機械仕掛けの夜：自分のモンスターは攻守500アップ。フォートレスは相手の機械族も素材にできる', () => {
    let s = game();
    s = act(s, {
      type: 'MOVE',
      uid: find(s, 'deck', '機械仕掛けの夜－クロック・ワーク・ナイト－'),
      to: { zone: 'stz', index: 0 },
      faceUp: true,
    });
    s = put(s, find(s, 'deck', 'サイバー・ドラゴン'), 0);
    const cd = s.mz[0]!;
    expect(currentStats(s, ctx, cd).atk).toBe(2600);
    // 相手のモンスター（灰流うらら：アンデット族）も機械族になるので素材にできる
    s = act(s, { type: 'OPP_PLACE', defId: '14558127', to: { zone: 'omz', index: 0 }, faceUp: true, position: 'atk' });
    const opp = s.opp!.mz[0]!;
    s = act(s, {
      type: 'PROC_SUMMON',
      uid: find(s, 'extra', 'キメラテック・フォートレス・ドラゴン'),
      proc: 0,
      materials: [cd, opp],
      to: mz(1),
    });
    expect(name(s, s.mz[1]!)).toBe('キメラテック・フォートレス・ドラゴン');
    expect(currentStats(s, ctx, s.mz[1]!).atk).toBe(2000 + 500);
  });

  it('サイバー・ダーク・ヴルム②はデュエル中に1度だけ', () => {
    let s = game();
    s = put(s, find(s, 'deck', 'サイバー・ドラゴン'), 0);
    s = toZone(s, find(s, 'deck', 'サイバー・ダーク・ヴルム'), 'hand');
    const vrm = find(s, 'hand', 'サイバー・ダーク・ヴルム');
    s = useEffect(s, vrm, '② 「サイバー・ドラゴン」モンスターを墓地へ送り', [
      { pick: ['サイバー・ドラゴン・コア'] },
      { zone: mz(1) },
      { pick: [] },
    ]);
    expect(s.mz[1]).toBe(vrm);
    s = act(s, { type: 'MOVE', uid: vrm, to: { zone: 'gy' } });
    s = act(s, { type: 'END_TURN', toOpponent: true });
    s = act(s, { type: 'END_TURN' });
    s = act(s, { type: 'NEXT_PHASE', to: 'M1' });
    expect(tryEffect(s, vrm, '② 「サイバー・ドラゴン」モンスターを墓地へ送り', [])).toMatch(/1度/);
  });
});
