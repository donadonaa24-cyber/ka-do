import { describe, expect, it } from 'vitest';
import { coachFromRoute, explainStep } from '../engine/coach';
import { applyAction, createGame, type Ctx } from '../engine/game';
import { findGuideAction, routeFromGuide } from '../engine/guide';
import { solveBest as solve } from '../engine/solver';
import { BUILTIN_DECKS, CARD_DB, CARD_SCRIPTS, PRE_LIMIT_TOON_DECK, TOON_DECK } from '.';
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
      let s = createGame(BUILTIN_DECKS.find((d) => d.name === guide.deckName)!, ctx, guide.seed, guide.fixedHand);
      for (const [i, step] of guide.steps.entries()) {
        const action = findGuideAction(s, ctx, step);
        if (!action) {
          const board = [...s.emz, ...s.mz].map((u) => (u ? CARD_DB[s.cards[u].defId].name : '-')).join(' / ');
          const hand = s.hand.map((u) => CARD_DB[s.cards[u].defId].name).join('、');
          throw new Error(`手順${i + 1}が見つかりません: ${step.text}\n場: ${board}\n手札: ${hand}`);
        }
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(r.error);
        s = r.state;
      }
    }, 30000);
  }
});

describe('記事のルートを最適ルートの候補にする', () => {
  it('完全なる世界1枚：記事の最終盤面（4妨害＋心を見通す眼）になり、探索より評価が高い', () => {
    const guide = TOON_GUIDES.find((g) => g.id === 'world-1card-prelimit')!;
    // ガイドと違う初手・デッキ順でも動ける
    const s = createGame(PRE_LIMIT_TOON_DECK, ctx, 2, ['7293697', '59438930', '14558127', '40366667', '23434538']);
    const route = routeFromGuide(s, ctx, guide, TOON_EVALUATOR)!;
    expect(route).not.toBeNull();
    const names = (us: (string | null)[]) =>
      us.filter((u): u is string => !!u).map((u) => CARD_DB[route.final.cards[u].defId].name);
    const field = names([...route.final.emz, ...route.final.mz]);
    expect(field).toEqual(
      expect.arrayContaining([
        'ドラグニティロード－ゲオルギアス',
        'フルール・ド・バロネス',
        'ブルーアイズ・トゥーン・アルティメットドラゴン',
      ]),
    );
    expect(names(route.final.banished)).toContain('光なき影 ア＝バオ・ア・クゥー');
    expect(names(route.final.stz)).toEqual(
      expect.arrayContaining(['心を見通す眼', 'トゥーン・テラー', 'ドラグニティナイト－ハールーン']),
    );
    const searched = solve(s, ctx, TOON_EVALUATOR, {});
    expect(route.score).toBeGreaterThan(searched[0].score);
  }, 60000);
});
