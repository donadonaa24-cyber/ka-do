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
  isNegated,
  type MonsterLocation,
} from '../engine/game';
import type { GameState, Location } from '../engine/types';
import { deckProblems } from '../ui/deckStore';
import { CARD_DB, CARD_SCRIPTS, TG_DECK } from '.';

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
const synchro = (s: GameState, n: string, materials: string[], to: MonsterLocation) =>
  applyAction(s, { type: 'PROCEDURE_SUMMON', method: 'synchro', uid: find(s, 'extra', n), materials, to }, ctx);

describe('ＴＧ', () => {
  it('デッキはメイン42枚・EX15枚・サイド15枚で登録できる', () => {
    expect(TG_DECK.main).toHaveLength(42);
    expect(TG_DECK.extra).toHaveLength(15);
    expect(TG_DECK.side).toHaveLength(15);
    expect(deckProblems(TG_DECK, CARD_DB)).toEqual([]);
    for (const id of [...TG_DECK.main, ...TG_DECK.extra, ...(TG_DECK.side ?? [])]) expect(CARD_DB[id], id).toBeTruthy();
  });

  it('ロケット・サラマンダー①：自分の「ＴＧ」をリリースし、カード名が異なる「ＴＧ」をデッキから特殊召喚', () => {
    let s = createGame(TG_DECK, ctx, 1, []);
    s = put(s, find(s, 'deck', 'ＴＧ ロケット・サラマンダー'), 0);
    const sala = s.mz[0]!;
    // リリースしたモンスターと同じ名前（サラマンダー）は選べない
    expect(() =>
      tryEffect(s, sala, '① 自分の「ＴＧ」をリリース', [
        { pick: ['ＴＧ ロケット・サラマンダー'] },
        { pick: ['ＴＧ ロケット・サラマンダー'], zone: mz(1) },
      ]),
    ).toThrow(/候補にありません/);
    s = useEffect(s, sala, '① 自分の「ＴＧ」をリリース', [
      { pick: ['ＴＧ ロケット・サラマンダー'] },
      { pick: ['ＴＧ タンク・ラーヴァ'], zone: mz(1) },
    ]);
    expect(name(s, s.mz[1]!)).toBe('ＴＧ タンク・ラーヴァ');
    expect(s.gy).toContain(sala);
  });

  it('タンク・ラーヴァは「ＴＧ」SモンスターのS素材ならチューナー以外になり、②でＴＧトークンを出せる', () => {
    let s = createGame(TG_DECK, ctx, 1, []);
    s = put(s, find(s, 'deck', 'ＴＧ ギア・ゾンビ'), 0);
    s = put(s, find(s, 'deck', 'ＴＧ タンク・ラーヴァ'), 1);
    const larva = s.mz[1]!;
    // ギア・ゾンビ（チューナー）＋タンク・ラーヴァ（チューナー以外として）でレベル2の「ＴＧ」S
    const r = synchro(s, 'ＴＧ レシプロ・ドラゴン・フライ', [s.mz[0]!, larva], { zone: 'emz', index: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    s = useEffect(s, larva, '② 「ＴＧ」SモンスターのS素材', [{ zone: mz(2) }]);
    expect(name(s, s.mz[2]!)).toBe('ＴＧトークン');
    // ＴＧトークンは「ＴＧ」モンスターなので、スター・ガーディアン（チューナー以外は「ＴＧ」）の素材にできる
    // 2枚目のギア・ゾンビは手札に引いていることがある
    s = put(s, find(s, 'deck', 'ＴＧ ギア・ゾンビ') ?? find(s, 'hand', 'ＴＧ ギア・ゾンビ'), 0);
    s = put(s, find(s, 'deck', 'ＴＧ ワーウルフ') ?? find(s, 'hand', 'ＴＧ ワーウルフ'), 1);
    const sg = synchro(s, 'ＴＧ スター・ガーディアン', [s.mz[2]!, s.mz[0]!, s.mz[1]!], mz(3));
    expect(sg.ok ? '' : sg.error).toBe('');
  });

  it('サイバー・マジシャン：手札の「ＴＧ」モンスターもS素材にできる（マイティ・ストライカー①でサーチ）', () => {
    // サイバー・マジシャンはサイドデッキなので、メインに入れたデッキで試す
    let s = createGame({ ...TG_DECK, main: [...TG_DECK.main, '64910482'] }, ctx, 1, []);
    s = toZone(s, find(s, 'deck', 'ＴＧ ブースター・ラプトル'), 'hand');
    const raptor = find(s, 'hand', 'ＴＧ ブースター・ラプトル');
    // サイバー・マジシャンがいなければ、手札のモンスターは素材にできない
    s = put(s, find(s, 'deck', 'ＴＧ ギア・ゾンビ'), 0);
    expect(synchro(s, 'ＴＧ マイティ・ストライカー', [s.mz[0]!, raptor], { zone: 'emz', index: 0 }).ok).toBe(false);
    s = put(s, find(s, 'deck', 'ＴＧ サイバー・マジシャン'), 1);
    const r = synchro(s, 'ＴＧ マイティ・ストライカー', [s.mz[1]!, raptor], { zone: 'emz', index: 0 });
    if (!r.ok) throw new Error(r.error);
    s = r.state;
    expect(s.gy).toContain(raptor);
    s = useEffect(s, s.emz[0]!, '① S召喚した場合', [{ pick: ['ＴＧ－ブレイクリミッター'] }]);
    expect(s.hand.map((u) => name(s, u))).toContain('ＴＧ－ブレイクリミッター');
  });

  it('スクリュー・サーペント①：墓地のレベル4以下の「ＴＧ」を効果無効で特殊召喚。②でレベルをターン終了時まで変える', () => {
    let s = createGame(TG_DECK, ctx, 1, []);
    s = toZone(s, find(s, 'deck', 'ＴＧ ワーウルフ'), 'gy');
    s = put(s, find(s, 'deck', 'ＴＧ スクリュー・サーペント'), 0);
    s = useEffect(s, s.mz[0]!, '① 召喚・特殊召喚した場合', [{ pick: ['ＴＧ ワーウルフ'] }, { zone: mz(1) }]);
    const wolf = s.mz[1]!;
    expect(name(s, wolf)).toBe('ＴＧ ワーウルフ');
    expect(isNegated(s, wolf)).toBe(true);
    // ②：墓地の別のサーペントを除外して、ワーウルフのレベルを1つ上げる
    s = toZone(s, find(s, 'deck', 'ＴＧ スクリュー・サーペント'), 'gy');
    const serpentGy = find(s, 'gy', 'ＴＧ スクリュー・サーペント');
    s = useEffect(s, serpentGy, '② 墓地から除外', [{ pick: ['ＴＧ ワーウルフ'], mode: 0 }]);
    expect(currentLevel(s, ctx, wolf)).toBe(4);
    expect(s.banished).toContain(serpentGy);
    s = act(s, { type: 'END_TURN', toOpponent: true });
    expect(currentLevel(s, ctx, wolf)).toBe(3);
  });

  it('オールクリア③でフィールドの「ＴＧ」を破壊すると、そのモンスターはエンドフェイズにサーチできる', () => {
    let s = createGame(TG_DECK, ctx, 1, []);
    s = act(s, {
      type: 'MOVE',
      uid: find(s, 'deck', 'ＴＧ－オールクリア'),
      to: { zone: 'stz', index: 0 },
      faceUp: true,
    });
    s = put(s, find(s, 'deck', 'ＴＧ ワーウルフ'), 0);
    const wolf = s.mz[0]!;
    s = useEffect(s, s.stz[0]!, '③ 手札・フィールドの「ＴＧ」を破壊', [
      { pick: ['ＴＧ ワーウルフ'] },
      { pick: ['ＴＧ ブースター・ラプトル'] },
    ]);
    expect(s.gy).toContain(wolf);
    expect(s.hand.map((u) => name(s, u))).toContain('ＴＧ ブースター・ラプトル');
    // メインフェイズにはまだ使えない
    expect(tryEffect(s, wolf, 'エンドフェイズ', [{ pick: ['ＴＧ ストライカー'] }])).toMatch(/エンドフェイズ/);
    s = act(s, { type: 'NEXT_PHASE', to: 'EP' });
    s = useEffect(s, wolf, 'エンドフェイズ', [{ pick: ['ＴＧ ストライカー'] }]);
    expect(s.hand.map((u) => name(s, u))).toContain('ＴＧ ストライカー');
  });

  it('俺ルールの特殊召喚：正規の召喚をしていないSモンスターも墓地から出せ、その後は正規の召喚をしたものとして扱う', () => {
    let s = createGame(TG_DECK, ctx, 1, []);
    const sg = find(s, 'extra', 'ＴＧ スター・ガーディアン');
    s = act(s, { type: 'SPECIAL_SUMMON', uid: sg, to: { zone: 'emz', index: 0 }, free: true });
    s = act(s, { type: 'MOVE', uid: sg, to: { zone: 'gy' } });
    // 効果での蘇生もできる（正規の召喚をしたものとして扱う）
    expect(s.cards[sg].properlySummoned).toBe(true);
    s = act(s, { type: 'SPECIAL_SUMMON', uid: sg, to: mz(0) });
    expect(s.mz[0]).toBe(sg);
  });

  it('ブースター・ラプトルは自分の「ＴＧ」がいれば手札から特殊召喚できる（1ターンに1度）', () => {
    let s = createGame(TG_DECK, ctx, 1, []);
    s = toZone(s, find(s, 'deck', 'ＴＧ ブースター・ラプトル'), 'hand');
    const raptor = find(s, 'hand', 'ＴＧ ブースター・ラプトル');
    expect(applyAction(s, { type: 'PROC_SUMMON', uid: raptor, proc: 0, materials: [], to: mz(1) }, ctx).ok).toBe(false);
    s = put(s, find(s, 'deck', 'ＴＧ ワーウルフ'), 0);
    s = act(s, { type: 'PROC_SUMMON', uid: raptor, proc: 0, materials: [], to: mz(1) });
    expect(s.mz[1]).toBe(raptor);
  });
});
