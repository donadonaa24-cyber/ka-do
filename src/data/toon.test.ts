import { describe, expect, it } from 'vitest';
import { type Action, applyAction, createGame, type Ctx, findLocation } from '../engine/game';
import type { GameState, Location } from '../engine/types';
import {
  afterPick,
  chainableEffects,
  completeStep,
  type RunResult,
  type Running,
  startEffect,
  startResolve,
  stepCandidates,
} from '../engine/effectRunner';
import { CARD_DB, CARD_SCRIPTS, TOON_DECK } from '.';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const name = (s: GameState, u: string) => CARD_DB[s.cards[u].defId].name;
const inHand = (s: GameState, n: string) => s.hand.find((u) => name(s, u) === n)!;
const inZone = (s: GameState, zone: 'deck' | 'gy' | 'extra' | 'hand', n: string) =>
  s[zone].find((u) => name(s, u) === n)!;

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
  let r: RunResult = skipTempBanish(startEffect(s, ctx, uid, effect));
  for (const c of choices) {
    r = skipTempBanish(r);
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
  r = skipTempBanish(r);
  if (r.kind === 'error') throw new Error(r.error);
  if (r.kind === 'running') throw new Error(`効果処理が終わっていません（step ${r.run.stepIndex}）`);
  return act(s, r.action);
}

/** 完全なる世界③（処理後まで除外）を聞かれたら使わない */
function skipTempBanish(r: RunResult): RunResult {
  while (r.kind === 'running' && r.run.extraStep) r = afterPick({ ...r.run, picked: [] }, ctx);
  return r;
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
    s = useEffect(s, cat, '②', [
      { pick: ['ファニー・ダーク・ラビット'] },
      { pick: ['ブルーアイズ・トゥーン・ドラゴン'], zone: mz(0) },
    ]);
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
    expect(applyAction(s, { type: 'PROC_SUMMON', uid: shade, proc: 0, materials: [], to: mz(0) }, ctx)).toMatchObject({
      ok: false,
    });
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    // カオス・ソルジャー：トゥーンモンスターをレベル合計8以上リリース（ラビットLv4だけでは不足）
    const chaos = inHand(s, 'トゥーン・カオス・ソルジャー');
    const rabbit = inHand(s, 'ファニー・ダーク・ラビット');
    expect(
      applyAction(s, { type: 'PROC_SUMMON', uid: chaos, proc: 0, materials: [rabbit], to: mz(0) }, ctx),
    ).toMatchObject({ ok: false });
    s = act(s, { type: 'SPECIAL_SUMMON', uid: chaos, to: mz(0), note: 'テスト' });
    s = act(s, { type: 'PROC_SUMMON', uid: shade, proc: 0, materials: [], to: mz(1) });
    s = useEffect(s, shade, '①', [{ pick: ['トゥーン・ブラック・マジシャン・ガール'] }]);
    expect(s.hand.map((u) => name(s, u))).toContain('トゥーン・ブラック・マジシャン・ガール');
  });

  it('アルティメット：BEトゥーン＋トゥーン2体をデッキに戻して特殊召喚', () => {
    let s = createGame(TOON_DECK, ctx, 5, ['53183600', '21296502', '64116319', '7293697']);
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    const mats = [
      'ブルーアイズ・トゥーン・ドラゴン',
      'トゥーン・ブラック・マジシャン',
      'トゥーン・ハーピィ・レディ',
    ].map((n) => inHand(s, n));
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
    expect(
      applyAction(s, { type: 'PROC_SUMMON', uid: destr, proc: 0, materials: [tbm], to: mz(1) }, ctx),
    ).toMatchObject({ ok: false });
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

describe('チェーン', () => {
  it('しおりにコミックキャット②をチェーンし、後から発動した方から解決する', () => {
    let s = createGame(TOON_DECK, ctx, 21, ['91500017', '72921536', '7293697']);
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    s = act(s, { type: 'NORMAL_SUMMON', uid: inHand(s, 'コミックキャット'), index: 0 });
    const cat = s.mz[0]!;

    // しおりを発動：キャット②でチェーンできるので、チェーン1に積まれて止まる
    const shiori = inHand(s, 'トゥーンのしおり');
    const shioriEffect = CARD_SCRIPTS['91500017'].effects![0];
    let r = startEffect(s, ctx, shiori, shioriEffect, undefined, 'auto');
    expect(r.kind).toBe('done');
    s = act(s, (r as { action: Action }).action);
    expect(s.chain).toHaveLength(1);
    expect(chainableEffects(s, ctx, 2).map((c) => name(s, c.uid))).toContain('コミックキャット');

    // チェーン中は召喚できない
    expect(applyAction(s, { type: 'NEXT_PHASE' }, ctx)).toMatchObject({ ok: false });

    // チェーン2：コミックキャット②
    const catEffect = CARD_SCRIPTS['72921536'].effects![0];
    // リリースはコストなので、チェーンに積む前に払う
    r = startEffect(s, ctx, cat, catEffect, undefined, 'auto');
    let run = (r as { run: Running }).run;
    r = skipTempBanish(afterPick({ ...run, picked: [cat] }, ctx));
    s = act(s, (r as { action: Action }).action);
    expect(s.chain).toHaveLength(2);
    expect(s.gy).toContain(cat);

    // チェーン2から解決：デッキからBEトゥーン
    r = skipTempBanish(startResolve(s, ctx));
    expect(r.kind).toBe('running');
    run = (r as { run: Running }).run;
    const be = stepCandidates(run, ctx).find((u) => name(run.temp, u) === 'ブルーアイズ・トゥーン・ドラゴン')!;
    r = afterPick({ ...run, picked: [be] }, ctx);
    r = completeStep((r as { run: Running }).run, ctx, mz(1));
    s = act(s, (r as { action: Action }).action);
    expect(s.chain).toHaveLength(1);
    expect(name(s, s.mz[1]!)).toBe('ブルーアイズ・トゥーン・ドラゴン');

    // チェーン1：しおりのサーチ
    r = skipTempBanish(startResolve(s, ctx));
    run = (r as { run: Running }).run;
    const box = stepCandidates(run, ctx).find((u) => name(run.temp, u) === 'エビル・ボックス')!;
    r = afterPick({ ...run, picked: [box] }, ctx);
    s = act(s, (r as { action: Action }).action);
    expect(s.chain).toHaveLength(0);
    expect(s.hand).toContain(box);
    expect(s.gy.map((u) => name(s, u))).toContain('トゥーンのしおり');
  });

  it('チェーンできる効果が無ければ、その場で最後まで処理する', () => {
    const s = createGame(TOON_DECK, ctx, 22, ['89997728']);
    const r = startEffect(
      s,
      ctx,
      inHand(s, 'トゥーンのもくじ'),
      CARD_SCRIPTS['89997728'].effects![0],
      undefined,
      'auto',
    );
    expect(r.kind).toBe('running');
  });
});

describe('完全なる世界③（効果処理後まで除外）', () => {
  it('TBM③の処理中にTBM自身を除外すると、戻った後にもう一度③を使える', () => {
    let s = createGame(TOON_DECK, ctx, 31, ['7293697', '21296502', '89997728', '70560957']);
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    s = act(s, {
      type: 'SPECIAL_SUMMON',
      uid: inHand(s, 'トゥーン・ブラック・マジシャン'),
      to: mz(2),
      position: 'def',
    });
    const tbm = s.mz[2]!;
    const effect = CARD_SCRIPTS['21296502'].effects![0];

    // 1回目：コストでもくじを捨てる → 処理の前に③でTBMを除外 → ハーピィを特殊召喚 → TBMが戻る
    let r: RunResult = startEffect(s, ctx, tbm, effect);
    let run = (r as { run: Running }).run;
    r = afterPick(
      { ...run, picked: stepCandidates(run, ctx).filter((u) => name(run.temp, u) === 'トゥーンのもくじ') },
      ctx,
    );
    run = (r as { run: Running }).run;
    expect(run.extraStep).toBeDefined();
    r = afterPick({ ...run, picked: [tbm] }, ctx);
    run = (r as { run: Running }).run;
    expect(findLocation(run.temp, tbm)).toEqual({ zone: 'banished' });
    const harpy = stepCandidates(run, ctx).find((u) => name(run.temp, u) === 'トゥーン・ハーピィ・レディ')!;
    r = afterPick({ ...run, picked: [harpy] }, ctx);
    r = completeStep((r as { run: Running }).run, ctx, mz(3));
    s = act(s, (r as { action: Action }).action);
    // 同じゾーンに同じ表示形式で戻る
    expect(s.mz[2]).toBe(tbm);
    expect(s.cards[tbm].position).toBe('def');
    expect(s.mz[3]).toBe(harpy);

    // 2回目：戻ったTBMは別のカード扱いなので③をもう一度使える。TBMは③でもう除外できない
    r = startEffect(s, ctx, tbm, effect);
    run = (r as { run: Running }).run;
    r = afterPick(
      { ...run, picked: stepCandidates(run, ctx).filter((u) => name(run.temp, u) === 'トゥーン・ロールバック') },
      ctx,
    );
    run = (r as { run: Running }).run;
    if (run.extraStep) expect(stepCandidates(run, ctx)).not.toContain(tbm);
  });

  it('召喚後に除外されて戻ったラビットも、まだ適用していなければ①（召喚時に適用）を使える', () => {
    let s = createGame(TOON_DECK, ctx, 32, ['7293697', '45536531', '89997728']);
    s = useEffect(s, inHand(s, '完全なる世界 トゥーン・ワールド'), '発動');
    s = act(s, { type: 'NORMAL_SUMMON', uid: inHand(s, 'ファニー・ダーク・ラビット'), index: 0 });
    const rabbit = s.mz[0]!;
    // もくじの処理中にラビットを除外して戻す
    let r: RunResult = startEffect(s, ctx, inHand(s, 'トゥーンのもくじ'), CARD_SCRIPTS['89997728'].effects![0]);
    let run = (r as { run: Running }).run;
    r = afterPick({ ...run, picked: [rabbit] }, ctx);
    run = (r as { run: Running }).run;
    r = afterPick({ ...run, picked: [stepCandidates(run, ctx)[0]] }, ctx);
    s = act(s, (r as { action: Action }).action);
    expect(s.mz[0]).toBe(rabbit);
    const onSummon = CARD_SCRIPTS['45536531'].effects!.find((e) => e.onSummon)!;
    const applied = startEffect(s, ctx, rabbit, onSummon);
    expect(applied.kind).toBe('done');
    s = act(s, (applied as { action: Action }).action);
    expect(s.summonGrants.some((g) => g.source === 'ファニー・ダーク・ラビット')).toBe(true);
    // 適用は1ターンに1度（もう一度は使えない）
    expect(startEffect(s, ctx, rabbit, onSummon).kind).toBe('error');
    // ③（カード名の付かない1ターンに1度）は使える
    const third = CARD_SCRIPTS['45536531'].effects!.find((e) => e.label.startsWith('③'))!;
    expect(startEffect(s, ctx, rabbit, third).kind).toBe('running');
  });
});
