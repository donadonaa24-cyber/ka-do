// ルート探索を別スレッドで行う（画面を固めないため）
import { CARD_DB, CARD_SCRIPTS } from '../data';
import { TOON_EVALUATOR } from '../data/toonEval';
import type { Ctx } from '../engine/game';
import { solve } from '../engine/solver';
import type { GameState } from '../engine/types';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };

self.onmessage = (e: MessageEvent<{ state: GameState }>) => {
  const routes = solve(e.data.state, ctx, TOON_EVALUATOR, {
    onProgress: (ratio) => self.postMessage({ type: 'progress', ratio }),
  });
  self.postMessage({
    type: 'done',
    routes: routes.map((r) => ({
      score: r.score,
      summary: r.summary,
      steps: r.steps,
      // 最終盤面に残るカード（解説で「最後まで残る」と伝えるため）
      finalUids: [...r.final.mz, ...r.final.emz, ...r.final.stz, r.final.fz].filter((u): u is string => !!u),
    })),
  });
};
