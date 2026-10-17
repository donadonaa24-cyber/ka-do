import { describe, expect, it } from 'vitest';
import { type Action, applyAction, createGame, type Ctx, findLocation } from '../engine/game';
import type { GameState, Location } from '../engine/types';
import { afterPick, completeStep, type RunResult, type Running, startEffect, stepCandidates } from '../engine/effectRunner';
import { CARD_DB, CARD_SCRIPTS, TOON_DECK } from '.';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const name = (s: GameState, u: string) => CARD_DB[s.cards[u].defId].name;
const inHand = (s: GameState, n: string) => s.hand.find((u) => name(s, u) === n)!;
const inZone = (s: GameState, zone: 'deck' | 'gy' | 'extra' | 'hand', n: string) => s[zone].find((u) => name(s, u) === n)!;

function act(s: GameState, a: Action): GameState {
  const r = applyAction(s, a, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

/** 効果を発動し、choices の順にカード名（とゾーン・処理の種類）を選んで最後まで解決する */
function useEffect(
  s: GameState,
  uid: string,
  label: string,
  choices: { pick?: string[]; zone?: Location; mode?: number }[] = [],
): GameState {
  const effect = CARD_SCRIPTS[s.cards[uid].defId].effects!.find((e) => e.label.includes(label));
  if (!effect) throw new Error(`効果がありません: ${label}`);
  let r: RunResult = startEffect(s, ctx, uid, effect);
  for (const c of choices) {
    if (r.kind !== 'running') break;
    let run: Running = r.run;
    if (c.pick) {
      const cands = stepCandidates(run, ctx);
      const picked = c.pick.map((n) => {
        const u = cands.find((x) => name(run.temp, x) === n && !run.picked.includes(x));
        if (!u) throw new Error(`候補にありません: ${n}（候補: ${cands.map((x) => name(run.temp, x)).join('、')}）`);
        return u;
      });
      run = { ...run, picked };
      r = afterPick(run, ctx);
      if (r.kind === 'running' && c.mode !== undefined) r = afterPick({ ...r.run, mode: c.mode }, ctx);
      if (r.kind === 'running' && r.run.stage === 'zone' && c.zone) r = completeStep(r.run, ctx, c.zone);
    } else if (c.zone) {
      r = completeStep(run, ctx, c.zone);
    }
  }
  if (r.kind === 'error') throw new Error(r.error);
  if (r.kind === 'running') throw new Error(`効果処理が終わっていません（step ${r.run.stepIndex}）`);
  return act(s, r.action);
}

const mz = (index: number) => ({ zone: 'mz' as const, index });

describe('トゥーンデッキ', () => {
  it('デッキは40枚・EX15枚で、全カードが登録されている', () => {
    expect(TOON_DECK.main).toHaveLength(40);
    expect(TOON_DECK.extra).toHaveLength(15);
    for (const id of [...TOON_DECK.main, ...TOON_DECK.extra]) expect(CARD_DB[id]).toBeDefined();
  });

  it('しおり → 完全なる世界 → ②でサーチ', () => {
    let s = createGame(TOON_DECK, ctx, 1, ['91500017']);
    s = useEffect(s, inHand(s, 'トゥーンのしおり'), '発動', [{ pick: ['完全なる世界 トゥーン・ワールド'] }]);
    expect(name(s, s.gy[0])).toBe('トゥーンのしおり');
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    expect(name(s, s.fz!)).toBe('完全なる世界 トゥーン・ワールド');
    s = useEffect(s, s.fz!, '②', [{ pick: ['トゥーンのもくじ'] }]);
    expect(s.hand.map((u) => name(s, u))).toContain('トゥーンのもくじ');
    expect(() => useEffect(s, s.fz!, '②', [{ pick: ['トゥーンのもくじ'] }])).toThrow('1度まで');
  });

  it('トゥーンのしおりは1ターンに1枚しか発動できない', () => {
    let s = createGame(TOON_DECK, ctx, 1, ['91500017', '91500017']);
    const [a, b] = s.hand.filter((u) => name(s, u) === 'トゥーンのしおり');
    s = useEffect(s, a, '発動', [{ pick: ['トゥーン・キングダム'] }]);
    expect(() => useEffect(s, b, '発動', [{ pick: ['完全なる世界 トゥーン・ワールド'] }])).toThrow('1枚しか');
  });

  it('ラビットで追加召喚、コミックキャットでBEトゥーンをデッキから特殊召喚', () => {
    let s = createGame(TOON_DECK, ctx, 2, ['45536531', '72921536', '7293697']);
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    s = act(s, { type: 'NORMAL_SUMMON', uid: inHand(s, 'ファニー・ダーク・ラビット'), index: 0 });
    const rabbit = s.mz[0]!;
    s = useEffect(s, rabbit, '①');
    expect(s.summonGrants).toHaveLength(1);
    // 追加召喚でコミックキャット（「トゥーン・ワールド」記載）
    s = act(s, { type: 'NORMAL_SUMMON', uid: inHand(s, 'コミックキャット'), index: 1, grant: 0 });
    expect(s.summonGrants).toHaveLength(0);
    const cat = s.mz[1]!;
    // ラビット③：デッキからキングダムを表側で置く（張り替え）
    s = useEffect(s, rabbit, '③', [{ pick: ['トゥーン・キングダム'], mode: 1 }]);
    expect(name(s, s.fz!)).toBe('トゥーン・キングダム');
    // キャット②：ラビットをリリースしてBEトゥーンをデッキから
    s = useEffect(s, cat, '②', [{ pick: ['ファニー・ダーク・ラビット'] }, { pick: ['ブルーアイズ・トゥーン・ドラゴン'], zone: mz(0) }]);
    expect(name(s, s.mz[0]!)).toBe('ブルーアイズ・トゥーン・ドラゴン');
    expect(findLocation(s, rabbit)).toEqual({ zone: 'gy' });
  });

  it('TBM③：手札の「トゥーン」を捨ててデッキからトゥーンモンスター', () => {
    let s = createGame(TOON_DECK, ctx, 3, ['21296502', '89997728']);
    s = act(s, { type: 'SPECIAL_SUMMON', uid: inHand(s, 'トゥーン・ブラック・マジシャン'), to: mz(2) });
    s = useEffect(s, s.mz[2]!, 'トゥーンモンスターを特殊召喚', [
      { pick: ['トゥーンのもくじ'] },
      { pick: ['トゥーン・ハーピィ・レディ'], zone: mz(3) },
    ]);
    expect(name(s, s.mz[3]!)).toBe('トゥーン・ハーピィ・レディ');
    // 同じ③はターン1
    expect(() => useEffect(s, s.mz[2]!, '「トゥーン」魔法・罠', [])).toThrow('1度まで');
  });

  it('カートゥーン・シェード：通常召喚できないモンスターがいれば特殊召喚、①でサーチ', () => {
    let s = createGame(TOON_DECK, ctx, 4, ['55363218', '28711704', '7293697', '45536531']);
    const shade = inHand(s, 'カートゥーン・シェード');
    expect(applyAction(s, { type: 'PROC_SUMMON', uid: shade, proc: 0, materials: [], to: mz(0) }, ctx)).toMatchObject({ ok: false });
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    // カオス・ソルジャー：トゥーンモンスターをレベル合計8以上リリース（ラビットLv4だけでは不足）
    const chaos = inHand(s, 'トゥーン・カオス・ソルジャー');
    const rabbit = inHand(s, 'ファニー・ダーク・ラビット');
    expect(applyAction(s, { type: 'PROC_SUMMON', uid: chaos, proc: 0, materials: [rabbit], to: mz(0) }, ctx)).toMatchObject({ ok: false });
    s = act(s, { type: 'SPECIAL_SUMMON', uid: chaos, to: mz(0), note: 'テスト' });
    s = act(s, { type: 'PROC_SUMMON', uid: shade, proc: 0, materials: [], to: mz(1) });
    s = useEffect(s, shade, '①', [{ pick: ['トゥーン・ブラック・マジシャン・ガール'] }]);
    expect(s.hand.map((u) => name(s, u))).toContain('トゥーン・ブラック・マジシャン・ガール');
  });

  it('アルティメット：BEトゥーン＋トゥーン2体をデッキに戻して特殊召喚', () => {
    let s = createGame(TOON_DECK, ctx, 5, ['53183600', '21296502', '64116319', '7293697']);
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    const mats = ['ブルーアイズ・トゥーン・ドラゴン', 'トゥーン・ブラック・マジシャン', 'トゥーン・ハーピィ・レディ'].map((n) => inHand(s, n));
    const ult = inZone(s, 'extra', 'ブルーアイズ・トゥーン・アルティメットドラゴン');
    s = act(s, { type: 'PROC_SUMMON', uid: ult, proc: 0, materials: mats, to: mz(2) });
    expect(s.mz[2]).toBe(ult);
    for (const m of mats) expect(findLocation(s, m)).toEqual({ zone: 'deck' });
  });

  it('滅びの黒魔術師：魔法発動後にLv6以上の闇魔法使いを除外して特殊召喚', () => {
    let s = createGame(TOON_DECK, ctx, 6, ['21296502', '89997728']);
    s = act(s, { type: 'SPECIAL_SUMMON', uid: inHand(s, 'トゥーン・ブラック・マジシャン'), to: mz(0) });
    const tbm = s.mz[0]!;
    const destr = inZone(s, 'extra', '滅びの黒魔術師');
    expect(applyAction(s, { type: 'PROC_SUMMON', uid: destr, proc: 0, materials: [tbm], to: mz(1) }, ctx)).toMatchObject({ ok: false });
    s = useEffect(s, inHand(s, 'トゥーンのもくじ'), '発動', [{ pick: ['トゥーンのしおり'] }]);
    s = act(s, { type: 'PROC_SUMMON', uid: destr, proc: 0, materials: [tbm], to: mz(1) });
    expect(findLocation(s, tbm)).toEqual({ zone: 'banished' });
    s = useEffect(s, destr, '②', [{ pick: ['トゥーン・ブラック・マジシャン・ガール'] }]);
    if (!s.hand.some((u) => name(s, u) === 'ティマイオスの眼光')) {
      s = act(s, { type: 'MOVE', uid: inZone(s, 'deck', 'ティマイオスの眼光'), to: { zone: 'hand' } });
    }
    // 眼光：滅び（ブラック・マジシャン扱い）を戻してドラグーン
    s = useEffect(s, inHand(s, 'ティマイオスの眼光'), '発動', [
      { pick: ['滅びの黒魔術師'] },
      { pick: ['超魔導竜騎士－ドラグーン・オブ・レッドアイズ'], zone: mz(1) },
    ]);
    expect(name(s, s.mz[1]!)).toBe('超魔導竜騎士－ドラグーン・オブ・レッドアイズ');
    expect(findLocation(s, destr)).toEqual({ zone: 'extra' });
  });

  it('トゥーンモンスターは特殊召喚したターンに攻撃できず、BEトゥーンは攻撃時に500LP', () => {
    let s = createGame(TOON_DECK, ctx, 7, ['53183600']);
    const be = inHand(s, 'ブルーアイズ・トゥーン・ドラゴン');
    s = act(s, { type: 'SPECIAL_SUMMON', uid: be, to: mz(0) });
    s = act(s, { type: 'END_TURN' });
    s = act(s, { type: 'NEXT_PHASE', to: 'BP' });
    s = act(s, { type: 'ATTACK', uid: be });
    expect(s.lp).toBe(7500);
    expect(s.opponentLp).toBe(5000);
  });

  it('ノー・フェイス：墓地の記載モンスターを手札に加え、そのまま特殊召喚', () => {
    let s = createGame(TOON_DECK, ctx, 8, ['34314989', '64116319']);
    s = act(s, { type: 'MOVE', uid: inHand(s, 'トゥーン・ハーピィ・レディ'), to: { zone: 'gy' } });
    s = useEffect(s, inHand(s, '闇の眼を持つ幻想師・ノー・フェイス'), '墓地の', [
      { pick: ['トゥーン・ハーピィ・レディ'] },
      { pick: ['トゥーン・ハーピィ・レディ'], zone: mz(2) },
    ]);
    expect(name(s, s.mz[2]!)).toBe('トゥーン・ハーピィ・レディ');
  });

  it('キングダム発動でデッキの上3枚を裏側で除外', () => {
    let s = createGame(TOON_DECK, ctx, 9, ['43175858']);
    const top3 = s.deck.slice(0, 3);
    s = useEffect(s, inHand(s, 'トゥーン・キングダム'), '発動');
    expect(s.banished).toEqual(top3);
    expect(top3.every((u) => !s.cards[u].faceUp)).toBe(true);
  });
});
