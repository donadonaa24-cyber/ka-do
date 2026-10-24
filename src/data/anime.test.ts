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

  it('ハルバード・キャノン（アニメ版）③：フィールドから離れた時、S素材の一組を墓地から特殊召喚', () => {
    let s = createGame(DECK, ctx, 1, []);
    s = fromExtra(s, 'ＴＧ マイティ・ストライカー', 0);
    s = fromExtra(s, 'ＴＧ パワー・グラディエイター', 1);
    s = fromExtra(s, 'ＴＧ ハイパー・ライブラリアン', 2);
    const mats = [s.mz[0]!, s.mz[1]!, s.mz[2]!];
    const halberd = s.extra.find((u) => s.cards[u].defId === 'anime-97836203')!;
    s = act(s, {
      type: 'PROCEDURE_SUMMON',
      method: 'synchro',
      uid: halberd,
      materials: mats,
      to: { zone: 'emz', index: 0 },
    });
    s = act(s, { type: 'MOVE', uid: halberd, to: { zone: 'gy' }, reason: '効果で破壊' });
    s = useEffect(s, halberd, '③ フィールドから離れた時', [
      { pick: ['ＴＧ マイティ・ストライカー', 'ＴＧ パワー・グラディエイター', 'ＴＧ ハイパー・ライブラリアン'] },
    ]);
    expect(s.mz.filter(Boolean)).toHaveLength(3);
  });

  it('シューティング・クェーサー・ドラゴン（アニメ版）④：フィールドを離れた時、EXの「シューティング・スター・ドラゴン」を特殊召喚', () => {
    let s = createGame(DECK, ctx, 1, []);
    const quasar = s.extra.find((u) => s.cards[u].defId === 'anime-35952884')!;
    s = act(s, { type: 'SPECIAL_SUMMON', uid: quasar, to: { zone: 'emz', index: 0 }, as: 'synchro' });
    s = act(s, { type: 'MOVE', uid: quasar, to: { zone: 'gy' }, reason: '効果で破壊' });
    s = useEffect(s, quasar, '④ フィールドを離れた時', [{ pick: ['シューティング・スター・ドラゴン'], zone: mz(0) }]);
    expect(name(s, s.mz[0]!)).toBe('シューティング・スター・ドラゴン');
  });
});
