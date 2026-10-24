import { describe, expect, it } from 'vitest';
import {
  afterPick,
  completeStep,
  type RunResult,
  type Running,
  startEffect,
  stepCandidates,
} from '../engine/effectRunner';
import { type Action, applyAction, createGame, type Ctx, type MonsterLocation } from '../engine/game';
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

describe('アニメ版のカード', () => {
  // アニメ版を入れたＴＧデッキ
  const DECK = {
    ...TG_DECK,
    extra: [...TG_DECK.extra.slice(0, 12), 'anime-97836203', 'anime-35952884', '24696097'],
  };
  const fromExtra = (s: GameState, n: string, index: number) =>
    act(s, { type: 'SPECIAL_SUMMON', uid: find(s, 'extra', n), to: mz(index), as: 'synchro' });

  it('カード名・ステータスはOCG版と同じで、OCG版も残っている', () => {
    for (const id of ['51447164', '97836203']) {
      const a = CARD_DB[`anime-${id}`];
      expect(a.name).toBe(CARD_DB[id].name);
      expect([a.level, a.atk, a.def, a.attribute, a.race]).toEqual([
        CARD_DB[id].level,
        CARD_DB[id].atk,
        CARD_DB[id].def,
        CARD_DB[id].attribute,
        CARD_DB[id].race,
      ]);
      expect(a.variant).toBe('アニメ版');
      expect(CARD_SCRIPTS[id]).toBeTruthy();
    }
    expect(deckProblems(DECK, CARD_DB)).toEqual([]);
  });

  const animeIn = (s: GameState, id: string) => s.extra.find((u) => s.cards[u].defId === `anime-${id}`)!;

  it('ブレード・ガンナー（アニメ版）：相手ターンにS召喚でき、②で除外すると相手のエンドフェイズに戻ってくる', () => {
    const deck = { ...DECK, extra: [...DECK.extra, 'anime-51447164'] };
    let s = createGame(deck, ctx, 1, []);
    s = fromExtra(s, 'ＴＧ ワンダー・マジシャン', 0);
    s = fromExtra(s, 'ＴＧ パワー・グラディエイター', 1);
    const mats = [s.mz[0]!, s.mz[1]!];
    s = act(s, { type: 'END_TURN', toOpponent: true });
    // OCG版は相手ターンにS召喚できない
    const ocgBg = s.extra.find((u) => s.cards[u].defId === '51447164')!;
    const bad = applyAction(
      s,
      { type: 'PROCEDURE_SUMMON', method: 'synchro', uid: ocgBg, materials: mats, to: mz(2) },
      ctx,
    );
    expect(bad.ok).toBe(false);
    const bg = animeIn(s, '51447164');
    s = act(s, { type: 'PROCEDURE_SUMMON', method: 'synchro', uid: bg, materials: mats, to: mz(2) });
    expect(s.mz[2]).toBe(bg);
    s = useEffect(s, bg, '② 相手ターンに1度');
    expect(s.banished).toContain(bg);
    s = act(s, { type: 'NEXT_PHASE', to: 'EP' });
    expect(s.mz).toContain(bg);
    expect(s.cards[bg].faceUp).toBe(true);
    // ③：戦闘で破壊されたら、S素材の一組を墓地から特殊召喚
    s = act(s, { type: 'END_TURN' });
    s = act(s, { type: 'MOVE', uid: bg, to: { zone: 'gy' }, reason: '戦闘で破壊' });
    s = useEffect(s, bg, '③ 戦闘で破壊された時', [
      { pick: ['ＴＧ ワンダー・マジシャン', 'ＴＧ パワー・グラディエイター'] },
    ]);
    expect(mats.every((u) => s.mz.includes(u))).toBe(true);
  });

  it('ハルバード・キャノン（アニメ版）：①はS素材の数だけ使え、②でフィールドを離れるとEXの「ＴＧ ブレード・ガンナー」を特殊召喚', () => {
    let s = createGame(DECK, ctx, 1, []);
    s = fromExtra(s, 'ＴＧ マイティ・ストライカー', 0);
    s = fromExtra(s, 'ＴＧ パワー・グラディエイター', 1);
    s = fromExtra(s, 'ＴＧ ハイパー・ライブラリアン', 2);
    const halberd = animeIn(s, '97836203');
    s = act(s, {
      type: 'PROCEDURE_SUMMON',
      method: 'synchro',
      uid: halberd,
      materials: [s.mz[0]!, s.mz[1]!, s.mz[2]!],
      to: { zone: 'emz', index: 0 },
    });
    for (let i = 0; i < 3; i++) s = useEffect(s, halberd, '① 召喚・反転召喚・特殊召喚を無効');
    expect(tryEffect(s, halberd, '① 召喚・反転召喚・特殊召喚を無効')).toMatch('3回');
    // 次のターンになっても回数は戻らない
    s = act(s, { type: 'END_TURN', toOpponent: true });
    expect(tryEffect(s, halberd, '① 召喚・反転召喚・特殊召喚を無効')).toMatch('3回');
    s = act(s, { type: 'MOVE', uid: halberd, to: { zone: 'gy' }, reason: '効果で破壊' });
    s = useEffect(s, halberd, '② フィールドを離れた時', [{ pick: ['ＴＧ ブレード・ガンナー'], zone: mz(0) }]);
    expect(name(s, s.mz[0]!)).toBe('ＴＧ ブレード・ガンナー');
  });

  it('シューティング・クェーサー・ドラゴン（アニメ版）⑤：フィールドのモンスターを全て破壊し、「シューティング・スター・ドラゴン」をS召喚扱いで特殊召喚', () => {
    let s = createGame(DECK, ctx, 1, []);
    s = fromExtra(s, 'ＴＧ パワー・グラディエイター', 1);
    const glad = s.mz[1]!;
    const quasar = animeIn(s, '35952884');
    s = act(s, { type: 'SPECIAL_SUMMON', uid: quasar, to: { zone: 'emz', index: 0 }, as: 'synchro' });
    s = act(s, { type: 'MOVE', uid: quasar, to: { zone: 'gy' }, reason: '効果で破壊' });
    s = useEffect(s, quasar, '⑤ フィールドを離れた時', [{ pick: ['シューティング・スター・ドラゴン'], zone: mz(0) }]);
    expect(s.gy).toContain(glad);
    expect(name(s, s.mz[0]!)).toBe('シューティング・スター・ドラゴン');
    expect(s.cards[s.mz[0]!].summonType).toBe('synchro');
  });
});

describe('シンクロン・クェーサー（OCG版）', () => {
  const DECK = {
    ...TG_DECK,
    extra: [...TG_DECK.extra.slice(0, 12), '50091196', '35952884', '24696097'],
  };
  const fromExtra = (s: GameState, n: string, index: number) =>
    act(s, { type: 'SPECIAL_SUMMON', uid: find(s, 'extra', n), to: mz(index), as: 'synchro' });

  it('フォーミュラ・シンクロン①：S召喚に成功した時に1枚ドロー', () => {
    let s = createGame(DECK, ctx, 1, []);
    const any = (n: string) => s.deck.find((u) => name(s, u) === n) ?? s.hand.find((u) => name(s, u) === n)!;
    const zombie = any('ＴＧ ギア・ゾンビ');
    s = act(s, { type: 'MOVE', uid: zombie, to: mz(0), faceUp: true, position: 'atk' });
    const fish = any('ＴＧ ドリル・フィッシュ');
    s = act(s, { type: 'MOVE', uid: fish, to: mz(1), faceUp: true, position: 'atk' });
    const formula = find(s, 'extra', 'フォーミュラ・シンクロン');
    s = act(s, { type: 'PROCEDURE_SUMMON', method: 'synchro', uid: formula, materials: [zombie, fish], to: mz(2) });
    const hand = s.hand.length;
    s = useEffect(s, formula, '① S召喚に成功した時');
    expect(s.hand.length).toBe(hand + 1);
  });

  it('フォーミュラ・シンクロン②で相手メインフェイズにクェーサーをS召喚。クェーサーはチューナー以外の素材の数まで攻撃でき、③でスターを出す', () => {
    let s = createGame(DECK, ctx, 1, []);
    s = fromExtra(s, 'フォーミュラ・シンクロン', 0);
    s = fromExtra(s, 'ＴＧ パワー・グラディエイター', 1);
    s = fromExtra(s, 'ＴＧ ハイパー・ライブラリアン', 2);
    const formula = s.mz[0]!;
    s = act(s, { type: 'END_TURN', toOpponent: true });
    s = useEffect(s, formula, '② 相手メインフェイズ', [
      { pick: ['シューティング・クェーサー・ドラゴン'] },
      {
        pick: ['フォーミュラ・シンクロン', 'ＴＧ パワー・グラディエイター', 'ＴＧ ハイパー・ライブラリアン'],
        zone: mz(3),
      },
    ]);
    const quasar = s.mz[3]!;
    expect(name(s, quasar)).toBe('シューティング・クェーサー・ドラゴン');
    // 自分のターン：チューナー以外の素材は2体なので2回まで攻撃できる
    s = act(s, { type: 'END_TURN' });
    s = act(s, { type: 'NEXT_PHASE', to: 'BP' });
    s = act(s, { type: 'ATTACK', uid: quasar });
    while (s.battle) s = act(s, { type: 'BATTLE_STEP' });
    expect(applyAction(s, { type: 'ATTACK', uid: quasar }, ctx).ok).toBe(true);
    const twice = structuredClone(s);
    twice.cards[quasar].attackCount = 2;
    expect(applyAction(twice, { type: 'ATTACK', uid: quasar }, ctx).ok).toBe(false);
    s = act(s, { type: 'MOVE', uid: quasar, to: { zone: 'gy' }, reason: '効果で破壊' });
    s = useEffect(s, quasar, '③ フィールドから離れた時', [{ pick: ['シューティング・スター・ドラゴン'], zone: mz(0) }]);
    expect(name(s, s.mz[0]!)).toBe('シューティング・スター・ドラゴン');
  });
});
