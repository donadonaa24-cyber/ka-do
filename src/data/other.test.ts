import { describe, expect, it } from 'vitest';
import {
  afterPick,
  completeStep,
  type RunResult,
  type Running,
  startEffect,
  stepCandidates,
} from '../engine/effectRunner';
import { type Action, applyAction, createGame, type Ctx, findLocation } from '../engine/game';
import type { DeckList, GameState } from '../engine/types';
import { deckProblems, uniqueName } from '../ui/deckStore';
import { CARD_DB, CARD_SCRIPTS, PRE_LIMIT_TOON_DECK, TOON_DECK } from '.';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const name = (s: GameState, u: string) => CARD_DB[s.cards[u].defId].name;

function act(s: GameState, a: Action): GameState {
  const r = applyAction(s, a, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

/** トゥーンデッキの一部を新しいカードに差し替えたデッキ */
const deckWith = (main: string[], extra: string[]): DeckList => ({
  name: 'テスト',
  main: [...main, ...TOON_DECK.main.slice(main.length)],
  extra: [...extra, ...TOON_DECK.extra.slice(extra.length)],
});

describe('デッキ外のカード', () => {
  it('テラ・フォーミングでフィールド魔法をサーチ', () => {
    let s = createGame(deckWith(['73628505'], []), ctx, 1, ['73628505']);
    const tf = s.hand.find((u) => name(s, u) === 'テラ・フォーミング')!;
    let r: RunResult = startEffect(s, ctx, tf, CARD_SCRIPTS['73628505'].effects![0]);
    const run = (r as { run: Running }).run;
    const names = stepCandidates(run, ctx).map((u) => name(run.temp, u));
    expect(new Set(names)).toEqual(new Set(['完全なる世界 トゥーン・ワールド', 'トゥーン・キングダム']));
    r = afterPick({ ...run, picked: [stepCandidates(run, ctx)[0]] }, ctx);
    s = act(s, (r as { action: Action }).action);
    expect(s.gy.map((u) => name(s, u))).toContain('テラ・フォーミング');
  });

  it('精霊コロゾ：リンクモンスターと魔法使い族を墓地へ送って特殊召喚', () => {
    let s = createGame(deckWith([], ['66532962']), ctx, 2, ['21296502']);
    const sheep = s.extra.find((u) => name(s, u) === 'クロシープ')!;
    const tbm = s.hand.find((u) => name(s, u) === 'トゥーン・ブラック・マジシャン')!;
    s = act(s, { type: 'SPECIAL_SUMMON', uid: sheep, to: { zone: 'emz', index: 0 } });
    s = act(s, { type: 'SPECIAL_SUMMON', uid: tbm, to: { zone: 'mz', index: 1 } });
    const corozo = s.extra.find((u) => name(s, u) === '精霊コロゾ')!;
    expect(
      applyAction(
        s,
        { type: 'PROC_SUMMON', uid: corozo, proc: 0, materials: [sheep], to: { zone: 'mz', index: 0 } },
        ctx,
      ),
    ).toMatchObject({ ok: false });
    s = act(s, { type: 'PROC_SUMMON', uid: corozo, proc: 0, materials: [sheep, tbm], to: { zone: 'mz', index: 0 } });
    expect(s.mz[0]).toBe(corozo);
    expect(findLocation(s, tbm)).toEqual({ zone: 'gy' });
  });

  it('ヴァレルロード・S・ドラゴン：墓地のリンクモンスターを装備してカウンターを置く', () => {
    let s = createGame(deckWith([], ['27548199']), ctx, 3);
    const link = s.extra.find((u) => name(s, u) === '神聖魔皇后セレーネ')!;
    s = act(s, { type: 'MOVE', uid: link, to: { zone: 'gy' } });
    const valel = s.extra.find((u) => name(s, u) === 'ヴァレルロード・Ｓ・ドラゴン')!;
    s = act(s, { type: 'SPECIAL_SUMMON', uid: valel, to: { zone: 'mz', index: 0 } });
    let r: RunResult = startEffect(s, ctx, valel, CARD_SCRIPTS['27548199'].effects![0]);
    r = afterPick({ ...(r as { run: Running }).run, picked: [link] }, ctx);
    // 装備する魔法＆罠ゾーンを選べる
    r = completeStep((r as { run: Running }).run, ctx, { zone: 'stz', index: 2 });
    s = act(s, (r as { action: Action }).action);
    expect(s.cards[valel].counters).toBe(3);
    expect(findLocation(s, link)).toEqual({ zone: 'stz', index: 2 });
    expect(s.cards[link].equippedTo).toBe(valel);
  });
});

describe('デッキ編集', () => {
  it('構築ルールの違反を見つける', () => {
    expect(deckProblems(TOON_DECK, CARD_DB)).toEqual([]);
    const bad: DeckList = { name: 'x', main: Array(4).fill('45536531'), extra: ['45536531'] };
    const problems = deckProblems(bad, CARD_DB).join('\n');
    expect(problems).toContain('40枚以上');
    expect(problems).toContain('3枚まで');
    expect(problems).toContain('EXデッキにメインデッキのカード');
  });

  it('デッキ名が重ならないようにする', () => {
    expect(uniqueName('トゥーン', ['トゥーン', 'トゥーン（2）'])).toBe('トゥーン（3）');
    expect(uniqueName('  ', [])).toBe('新しいデッキ');
  });
});

describe('禁止制限前トゥーン', () => {
  it('デッキはメイン40枚・EX15枚で、完全なる世界ともくじが3枚', () => {
    expect(PRE_LIMIT_TOON_DECK.main).toHaveLength(40);
    expect(PRE_LIMIT_TOON_DECK.extra).toHaveLength(15);
    expect(deckProblems(PRE_LIMIT_TOON_DECK, CARD_DB)).toEqual([]);
    const count = (id: string) => PRE_LIMIT_TOON_DECK.main.filter((x) => x === id).length;
    expect(count('7293697')).toBe(3);
    expect(count('89997728')).toBe(3);
  });

  it('完全なる世界②は張り替えても1ターンに3回まで', () => {
    // 3枚の完全なる世界を順に置き、それぞれの②を使う
    let s = createGame(PRE_LIMIT_TOON_DECK, ctx, 1, ['7293697']);
    const search = CARD_SCRIPTS['7293697'].effects![1];
    const useSearch = () => {
      const r = startEffect(s, ctx, s.fz!, search);
      if (r.kind !== 'running') return r;
      const run = r.run;
      return afterPick({ ...run, picked: [stepCandidates(run, ctx)[0]] }, ctx);
    };
    s = act(s, { type: 'ACTIVATE_CARD', uid: s.hand.find((u) => name(s, u) === '完全なる世界 トゥーン・ワールド')! });
    for (let i = 0; i < 3; i++) {
      const r = useSearch();
      expect(r.kind).toBe('done');
      s = act(s, (r as { action: Action }).action);
      expect(useSearch().kind).toBe('error'); // 同じカードではもう使えない
      const next = s.deck.find((u) => name(s, u) === '完全なる世界 トゥーン・ワールド');
      if (next && i < 2) {
        s = act(s, { type: 'MOVE', uid: s.fz!, to: { zone: 'gy' } });
        s = act(s, { type: 'MOVE', uid: next, to: { zone: 'fz' }, faceUp: true });
      }
    }
    const r = useSearch();
    expect(r.kind === 'error' && r.error).toContain('3度まで');
  });

  it('クロシープ：リンク先に融合モンスターが特殊召喚されたら墓地のレベル4以下を特殊召喚', () => {
    let s = createGame(PRE_LIMIT_TOON_DECK, ctx, 1, []);
    const sheep = s.extra.find((u) => name(s, u) === 'クロシープ')!;
    const btud = s.extra.find((u) => name(s, u) === 'ブルーアイズ・トゥーン・アルティメットドラゴン')!;
    const rabbit = s.deck.find((u) => name(s, u) === 'ファニー・ダーク・ラビット')!;
    s = act(s, { type: 'MOVE', uid: sheep, to: { zone: 'emz', index: 0 }, faceUp: true });
    s = act(s, { type: 'MOVE', uid: rabbit, to: { zone: 'gy' } });
    const effect = CARD_SCRIPTS['50277355'].effects![0];
    expect(startEffect(s, ctx, sheep, effect).kind).toBe('error'); // まだリンク先に出ていない
    s = act(s, { type: 'SPECIAL_SUMMON', uid: btud, to: { zone: 'mz', index: 0 } });
    let r: RunResult = startEffect(s, ctx, sheep, effect);
    const run = (r as { run: Running }).run;
    expect(stepCandidates(run, ctx).map((u) => name(run.temp, u))).toContain('ファニー・ダーク・ラビット');
    r = afterPick({ ...run, picked: [rabbit] }, ctx);
    r = completeStep((r as { run: Running }).run, ctx, { zone: 'mz', index: 2 });
    s = act(s, (r as { action: Action }).action);
    expect(findLocation(s, rabbit)).toEqual({ zone: 'mz', index: 2 });
  });
});
