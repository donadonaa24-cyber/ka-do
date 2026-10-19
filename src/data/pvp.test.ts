import { describe, expect, it } from 'vitest';
import { autoDrive, describeCpuStep } from '../engine/cpu';
import { startEffect, startResolve } from '../engine/effectRunner';
import { type Action, type Ctx, findLocation } from '../engine/game';
import { routeFromGuide } from '../engine/guide';
import { oppCanRespond } from '../engine/oppAI';
import {
  applyRequest,
  makeRequest,
  openingEntries,
  type PvpEntry,
  PvpReplay,
  pvpCtx,
  pvpReactions,
  pvpResponseOptions,
  type PvpSetup,
  type Slot,
  turnPlayer,
} from '../engine/pvp';
import type { GameState } from '../engine/types';
import { BLUE_EYES_DECK, CARD_DB, CARD_SCRIPTS, TOON_DECK } from '.';
import { BLUE_GUIDES } from './blueGuides';
import { TOON_EVALUATOR } from './toonEval';

const base: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const ctx = pvpCtx(base);
const name = (s: GameState, u: string) => CARD_DB[s.cards[u].defId].name;

/** 2人のプレイヤーの記録と、それを再生したゲーム（2台の端末をまとめて再現する） */
class Duel {
  logs: [PvpEntry[], PvpEntry[]] = [[], []];
  replay: PvpReplay;
  constructor(readonly setup: PvpSetup) {
    this.replay = new PvpReplay(setup, ctx);
    for (const p of [0, 1] as const) this.logs[p].push(...openingEntries(setup, p));
    this.ingest();
    this.settle();
  }
  game(p: Slot) {
    return this.replay.games[p];
  }
  ingest() {
    const err = this.replay.ingest(this.logs);
    if (err) throw new Error(err);
  }
  /** プレイヤー p の操作 */
  act(p: Slot, a: Action) {
    this.logs[p].push(a);
    this.ingest();
    this.settle();
  }
  /** お互いの端末が、相手の変化に反応し終わるまで進める */
  settle() {
    for (let guard = 0; guard < 20; guard++) {
      let moved = false;
      for (const p of [0, 1] as const) {
        const r = pvpReactions(this.replay, p, this.logs);
        if (!r.length) continue;
        this.logs[p].push(...r);
        this.ingest();
        moved = true;
      }
      if (!moved) return;
    }
    throw new Error('反応が終わりません');
  }
  /** チェーンを上から解決する */
  resolveChain(p: Slot) {
    for (let i = 0; this.game(p).chain.length && i < 10; i++) {
      const a = autoDrive(startResolve(this.game(p), ctx), ctx, new Set());
      if (!a) throw new Error('解決できません');
      this.act(p, a);
    }
  }
}

const guide = BLUE_GUIDES[0];
/** 1P：ブルーアイズ（先攻）、2P：灰流うらら・増殖するＧ・無限泡影を持つトゥーン（後攻） */
const newDuel = () =>
  new Duel({
    first: 0,
    players: [
      { deckName: 'ブルーアイズ', deck: BLUE_EYES_DECK, seed: guide.seed, fixedHand: guide.fixedHand },
      { deckName: 'トゥーン', deck: TOON_DECK, seed: 5, fixedHand: ['14558127', '23434538', '10045474'] },
    ],
  });

/** 1Pのルートの最初の効果（ディープアイズ①）を発動する */
function firstActivation(d: Duel) {
  const route = routeFromGuide(d.game(0), base, guide, TOON_EVALUATOR)!;
  const st = describeCpuStep(d.game(0), ctx, route.steps[0].action);
  const r = startEffect(d.game(0), ctx, st.uid!, st.effect!, undefined, 'auto');
  if (r.kind !== 'done') throw new Error(r.kind === 'error' ? r.error : '選択が残っています');
  d.act(0, r.action);
}

describe('通信対戦', () => {
  it('お互いの盤面・手札が相手の盤面として写る', () => {
    const d = newDuel();
    expect(d.game(1).opponentTurn).toBe(true);
    expect(d.game(0).opp!.hand).toHaveLength(5);
    expect(d.game(1).opp!.hand).toHaveLength(5);
    expect(d.game(0).opp!.deck).toHaveLength(d.game(1).deck.length);
    expect(turnPlayer(d.setup, d.logs)).toBe(0);
  });

  it('相手の効果の発動に手札誘発を使える。使ったカードはこちらのゲームで墓地へ', () => {
    const d = newDuel();
    firstActivation(d);
    // 2Pが灰流うららを持っているので、チェーンに積んで2Pの応答を待つ
    expect(d.game(0).chain).toHaveLength(1);
    expect(oppCanRespond(d.game(0), ctx)).toBe(true);
    const opts = pvpResponseOptions(d.replay, 1, ctx, []);
    expect(opts.map((o) => o.name)).toEqual(expect.arrayContaining(['灰流うらら', '増殖するＧ']));
    const ash = opts.find((o) => o.name === '灰流うらら')!;
    const action = applyRequest(d.game(0), ctx, makeRequest(d.game(0), 1, 'chain', ash))!;
    expect(action).toBeTruthy();
    d.act(0, action);
    expect(d.game(0).chain.map((l) => l.opp ?? '自分')).toEqual(['自分', 'ash']);
    // 2Pのゲームでも灰流うららが墓地へ
    expect(d.game(1).gy.map((u) => name(d.game(1), u))).toContain('灰流うらら');
    expect(d.game(1).hand).toHaveLength(4);
    // 2Pの応答の後は、もう2Pには聞かない
    expect(pvpResponseOptions(d.replay, 1, ctx, []).filter((o) => o.kind === 'chain')).toEqual([]);
    d.resolveChain(0);
    expect(d.game(0).log.some((l) => l.text.includes('灰流うらら') && l.text.includes('無効'))).toBe(true);
  });

  it('使わなければ「パス」で1Pの効果がそのまま処理される', () => {
    const d = newDuel();
    firstActivation(d);
    const hand = d.game(0).hand.length;
    d.act(0, applyRequest(d.game(0), ctx, makeRequest(d.game(0), 1, 'pass'))!);
    expect(oppCanRespond(d.game(0), ctx)).toBe(false);
    d.resolveChain(0);
    expect(d.game(0).hand.length).toBe(hand + 1); // 捨てた後にサーチした分
    expect(d.game(1).gy).toHaveLength(0);
  });

  it('ターンを終えると相手のターンになり、相手はドローする。相手の直接攻撃のダメージがこちらのLPに反映される', () => {
    const d = newDuel();
    d.act(0, { type: 'END_TURN', toOpponent: true });
    expect(turnPlayer(d.setup, d.logs)).toBe(1);
    const p2 = d.game(1);
    expect(p2.opponentTurn).toBe(false);
    expect(p2.hand).toHaveLength(6);
    // 2P：増殖するＧを通常召喚して直接攻撃
    let g = p2.hand.find((u) => name(p2, u) === '増殖するＧ')!;
    for (const to of ['SP', 'M1'] as const) d.act(1, { type: 'NEXT_PHASE', to });
    d.act(1, { type: 'NORMAL_SUMMON', uid: g, index: 2 });
    d.act(1, { type: 'NEXT_PHASE', to: 'BP' });
    g = d.game(1).mz[2]!;
    d.act(1, { type: 'ATTACK', uid: g });
    while (d.game(1).battle) d.act(1, { type: 'BATTLE_STEP' });
    expect(d.game(1).opponentLp).toBe(7500);
    expect(d.game(0).lp).toBe(7500);
    // 1Pの盤面にも2PのＧが写っている
    expect(d.game(0).opp!.mz[2]).toBeTruthy();
    // 2Pがターンを終えると1Pのターン（ドロー）
    const before = d.game(0).hand.length;
    d.act(1, { type: 'END_TURN', toOpponent: true });
    expect(turnPlayer(d.setup, d.logs)).toBe(0);
    expect(d.game(0).opponentTurn).toBe(false);
    expect(d.game(0).hand.length).toBe(before + 1);
  });

  it('相手のモンスターを戦闘で破壊すると、相手のゲームでも墓地へ送られる', () => {
    const d = newDuel();
    d.act(0, { type: 'END_TURN', toOpponent: true });
    const p2 = d.game(1);
    const g = p2.hand.find((u) => name(p2, u) === '増殖するＧ')!;
    for (const to of ['SP', 'M1'] as const) d.act(1, { type: 'NEXT_PHASE', to });
    d.act(1, { type: 'NORMAL_SUMMON', uid: g, index: 0 });
    d.act(1, { type: 'END_TURN', toOpponent: true });
    // 1P：手札の青眼の白龍を特殊召喚（練習用の操作）して攻撃
    const p1 = d.game(0);
    const be = [...p1.hand, ...p1.deck].find((u) => name(p1, u) === '青眼の白龍')!;
    for (const to of ['SP', 'M1'] as const) d.act(0, { type: 'NEXT_PHASE', to });
    d.act(0, { type: 'MOVE', uid: be, to: { zone: 'mz', index: 0 }, faceUp: true });
    d.act(0, { type: 'NEXT_PHASE', to: 'BP' });
    d.act(0, { type: 'ATTACK', uid: be, target: d.game(0).opp!.mz[0]! });
    while (d.game(0).battle) d.act(0, { type: 'BATTLE_STEP' });
    expect(findLocation(d.game(1), g)?.zone).toBe('gy');
    expect(d.game(1).lp).toBe(8000 - (3000 - 500));
  });
});
