// ルート探索を別スレッドで行う（画面を固めないため）
import { CARD_DB, CARD_SCRIPTS } from '../data';
import { TOON_EVALUATOR } from '../data/toonEval';
import { GUIDES } from '../data/guides';
import type { Ctx } from '../engine/game';
import { routeFromGuide } from '../engine/guide';
import { type Route, solveBest } from '../engine/solver';
import type { GameState } from '../engine/types';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };

self.onmessage = (e: MessageEvent<{ state: GameState; deckName: string }>) => {
  const found = solveBest(e.data.state, ctx, TOON_EVALUATOR, {
    onProgress: (ratio) => self.postMessage({ type: 'progress', ratio: ratio * 0.9 }),
  });
  // 記事などのルート（探索の深さでは届かない長い展開）も今の盤面から最後まで動ければ候補に入れる
  const fromGuides = GUIDES.filter((g) => g.deckName === e.data.deckName)
    .map((g) => routeFromGuide(e.data.state, ctx, g, TOON_EVALUATOR))
    .filter((r): r is Route => !!r);
  const routes = [...fromGuides, ...found].sort((a, b) => b.score - a.score).slice(0, 3);
  self.postMessage({
    type: 'done',
    routes: routes.map((r) => ({
      title: r.title,
      score: r.score,
      summary: r.summary,
      steps: r.steps,
      // 最終盤面に残るカード（解説で「最後まで残る」と伝えるため）
      finalUids: [...r.final.mz, ...r.final.emz, ...r.final.stz, r.final.fz].filter((u): u is string => !!u),
    })),
  });
};
