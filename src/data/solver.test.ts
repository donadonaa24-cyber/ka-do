import { describe, expect, it } from 'vitest';
import { coachFromRoute, explainStep } from '../engine/coach';
import { applyAction, createGame, type Ctx } from '../engine/game';
import { findGuideAction } from '../engine/guide';
import { solve } from '../engine/solver';
import { CARD_DB, CARD_SCRIPTS, TOON_DECK } from '.';
import { TOON_EVALUATOR } from './toonEval';
import { TOON_GUIDES } from './toonGuides';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };

describe('ルート探索', () => {
  it('ラビット1枚から展開ルートを見つける', () => {
    const s = createGame(TOON_DECK, ctx, 1, ['45536531', '14558127', '10045474', '6325660', '23434538']);
    const routes = solve(s, ctx, TOON_EVALUATOR, {});
    expect(routes.length).toBeGreaterThan(0);
    // スクショのルート（修正版）：完全なる世界＋エビル・ボックス＋テラー
    expect(routes[0].summary.join('\n')).toContain('伏せ：トゥーン・テラー');
    expect(routes[0].summary.join('\n')).toContain('エビル・ボックス');

    // 解説：ラビット③で置いた「完全なる世界」は後の手で効果を使う
    const final = routes[0].final;
    const coach = coachFromRoute(
      '最適ルート',
      routes[0].steps,
      routes[0].summary,
      s.log.length,
      [...final.mz, ...final.stz, final.fz].filter((u): u is string => !!u),
    );
    const nameOf = (u: string) => CARD_DB[routes[0].final.cards[u].defId].name;
    const placeWorld = coach.steps.findIndex((st) => st.sub.some((l) => l.includes('フィールドゾーンへ')));
    expect(explainStep(coach, placeWorld, nameOf).join('\n')).toMatch(
      /《完全なる世界 トゥーン・ワールド》は手順\d+で効果を使います/,
    );
  }, 30000);

  it('ノー・フェイス＋しおり＋キャット', () => {
    const s = createGame(TOON_DECK, ctx, 3, ['34314989', '91500017', '72921536', '14558127', '10045474']);
    const routes = solve(s, ctx, TOON_EVALUATOR, {});
    expect(routes[0].summary.join('\n')).toContain('心を見通す眼');
  }, 30000);
});

describe('ルートガイド', () => {
  for (const guide of TOON_GUIDES) {
    it(`「${guide.name}」を最後まで実行できる`, () => {
      let s = createGame(TOON_DECK, ctx, guide.seed, guide.fixedHand);
      for (const step of guide.steps) {
        const action = findGuideAction(s, ctx, step);
        if (!action) throw new Error(`手順が見つかりません: ${step.text}`);
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(r.error);
        s = r.state;
      }
    }, 30000);
  }
});
