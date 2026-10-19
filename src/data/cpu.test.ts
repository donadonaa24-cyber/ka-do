import { describe, expect, it } from 'vitest';
import { applyHandTrap, describeCpuStep, handTrapOptions, specialSummonsBetween, syncAction } from '../engine/cpu';
import { startEffect } from '../engine/effectRunner';
import { type Action, applyAction, createGame, type Ctx } from '../engine/game';
import { routeFromGuide } from '../engine/guide';
import type { GameState } from '../engine/types';
import { BLUE_EYES_DECK, BUILTIN_DECKS, CARD_DB, CARD_SCRIPTS, TOON_DECK } from '.';
import { BLUE_GUIDES } from './blueGuides';
import { TOON_EVALUATOR } from './toonEval';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const name = (s: GameState, u: string) => CARD_DB[s.cards[u].defId].name;
const act = (s: GameState, a: Action) => {
  const r = applyAction(s, a, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.state;
};

describe('CPU戦（CPUが先攻・プレイヤーが手札誘発）', () => {
  const guide = BLUE_GUIDES[0];
  const setup = () => {
    const cpu = createGame(BLUE_EYES_DECK, ctx, guide.seed, guide.fixedHand);
    const route = routeFromGuide(cpu, ctx, guide, TOON_EVALUATOR)!;
    // プレイヤー：灰流うらら・増殖するＧ・無限泡影を持つトゥーンデッキ（後攻）
    let human = createGame(TOON_DECK, ctx, 5, ['14558127', '23434538', '10045474']);
    human = act(human, { type: 'END_TURN', toOpponent: true });
    return { cpu, route, human };
  };

  it('CPUのサーチ効果に灰流うららを使える。止められた効果は処理されない', () => {
    const { cpu, route, human } = setup();
    // 最初にデッキからサーチする効果の手番を探す
    let s = cpu;
    let found = -1;
    for (const [i, st] of route.steps.entries()) {
      const opts = handTrapOptions(s, human, ctx, st.action, []);
      if (opts.some((o) => o.name === '灰流うらら')) {
        found = i;
        break;
      }
      s = act(s, st.action);
    }
    expect(found).toBeGreaterThanOrEqual(0);
    const action = route.steps[found].action;
    const step = describeCpuStep(s, ctx, action);
    const opt = handTrapOptions(s, human, ctx, action, []).find((o) => o.name === '灰流うらら')!;
    const res = applyHandTrap(s, ctx, action, opt, human)!;
    expect(res.replan).toBe(true);
    let after = s;
    for (const a of res.cpuActions) after = act(after, a);
    expect(after.chain).toEqual([]);
    expect(after.log.some((l) => l.text.includes('灰流うらら') && l.text.includes('無効'))).toBe(true);
    // 予定ではサーチしたカードが、手札に増えていない
    const planned = act(s, action);
    expect(after.hand.length).toBeLessThan(planned.hand.length);
    expect(step.kind).toBe('activate');
    // プレイヤーの手札から灰流うららが墓地へ
    let h = human;
    for (const a of res.humanActions) h = act(h, a);
    expect(h.gy.map((u) => name(h, u))).toContain('灰流うらら');
  });

  it('CPUの盤面を相手の盤面として写せる（特殊召喚の数も数えられる）', () => {
    const { cpu, route, human } = setup();
    let s = cpu;
    let ss = 0;
    for (const st of route.steps) {
      const next = act(s, st.action);
      ss += specialSummonsBetween(s, next);
      s = next;
    }
    expect(ss).toBeGreaterThan(2);
    const h = act(human, syncAction(s));
    const cpuField = [...s.mz, ...s.emz, ...s.stz].filter(Boolean).length;
    const oppField = [...h.opp!.mz, ...h.opp!.emz!, ...h.opp!.stz].filter(Boolean).length;
    expect(oppField).toBe(cpuField);
    expect(h.opp!.hand.length).toBe(s.hand.length);
    // 同期し直してもカードは増えない
    const h2 = act(h, syncAction(s));
    expect(Object.keys(h2.cards).length).toBe(Object.keys(h.cards).length);
  });
});

describe('CPUの盤面の妨害（プレイヤーのターン）', () => {
  it('CPUの究極竜魔導師が、プレイヤーの魔法の発動にチェーンして無効にしてくる', () => {
    const guide = BLUE_GUIDES[0];
    let cpu = createGame(BLUE_EYES_DECK, ctx, guide.seed, guide.fixedHand);
    for (const st of routeFromGuide(cpu, ctx, guide, TOON_EVALUATOR)!.steps) cpu = act(cpu, st.action);
    expect([...cpu.mz, ...cpu.emz].some((u) => u && name(cpu, u) === '究極竜魔導師')).toBe(true);
    let human = createGame(TOON_DECK, ctx, 32, ['7293697']);
    human = act(human, syncAction(cpu));
    const world = human.hand.find((u) => name(human, u) === '完全なる世界 トゥーン・ワールド')!;
    const eff = CARD_SCRIPTS['7293697'].effects!.find((e) => e.isCardActivation)!;
    const r = startEffect(human, ctx, world, eff, undefined, 'auto');
    expect(r.kind).toBe('done');
    human = act(human, (r as { action: Action }).action);
    expect(human.chain.map((l) => l.opp ?? '自分')).toEqual(['自分', 'magician']);
  });
});

describe('ＰＳＹフレームギア（CPU戦）', () => {
  it('γでCPUのモンスター効果を無効にして破壊し、γとドライバーを特殊召喚する。その後はδを使えない', () => {
    const guide = BLUE_GUIDES[0];
    let cpu = createGame(BLUE_EYES_DECK, ctx, guide.seed, guide.fixedHand);
    const route = routeFromGuide(cpu, ctx, guide, TOON_EVALUATOR)!;
    const deck = BUILTIN_DECKS.find((d) => d.name === '禁止制限前トゥーン')!;
    let human = createGame(deck, ctx, 5, ['38814750', '74203495']);
    human = act(human, { type: 'END_TURN', toOpponent: true });
    // 最初のモンスター効果（ディープアイズ①）にγ
    const action = route.steps[0].action;
    const opt = handTrapOptions(cpu, human, ctx, action, []).find((o) => o.name === 'ＰＳＹフレームギア・γ')!;
    expect(opt).toBeTruthy();
    const res = applyHandTrap(cpu, ctx, action, opt, human)!;
    for (const a of res.cpuActions) cpu = act(cpu, a);
    expect(cpu.log.some((l) => l.text.includes('ＰＳＹフレームギア・γの効果') && l.text.includes('無効'))).toBe(true);
    for (const a of res.humanActions) human = act(human, a);
    const field = human.mz.filter((u): u is string => !!u).map((u) => name(human, u));
    expect(field.sort()).toEqual(['ＰＳＹフレーム・ドライバー', 'ＰＳＹフレームギア・γ'].sort());
    expect(res.banishAtEnd).toHaveLength(2);
    // 自分フィールドにモンスターがいるので、もうδは使えない
    for (const st of route.steps.slice(1)) {
      const names = handTrapOptions(cpu, human, ctx, st.action, ['ＰＳＹフレームギア・γ']).map((o) => o.name);
      expect(names).not.toContain('ＰＳＹフレームギア・δ');
      const r = applyAction(cpu, st.action, ctx);
      if (!r.ok) break;
      cpu = r.state;
    }
  });

  it('ドライバーが手札・デッキ・墓地に無ければ使えない', () => {
    const guide = BLUE_GUIDES[0];
    const cpu = createGame(BLUE_EYES_DECK, ctx, guide.seed, guide.fixedHand);
    const route = routeFromGuide(cpu, ctx, guide, TOON_EVALUATOR)!;
    const deck = BUILTIN_DECKS.find((d) => d.name === '禁止制限前トゥーン')!;
    let human = createGame(deck, ctx, 5, ['38814750']);
    const driver = human.deck.find((u) => name(human, u) === 'ＰＳＹフレーム・ドライバー')!;
    human = act(human, { type: 'MOVE', uid: driver, to: { zone: 'banished' } });
    human = act(human, { type: 'END_TURN', toOpponent: true });
    const names = handTrapOptions(cpu, human, ctx, route.steps[0].action, []).map((o) => o.name);
    expect(names).not.toContain('ＰＳＹフレームギア・γ');
  });
});
