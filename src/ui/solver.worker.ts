// ルート探索を別スレッドで行う（画面を固めないため）
import { CARD_DB, CARD_SCRIPTS } from '../data';
import { TOON_EVALUATOR } from '../data/toonEval';
import { GUIDES } from '../data/guides';
import type { Ctx } from '../engine/game';
import { routeFromGuide } from '../engine/guide';
import { type Route, solveBest } from '../engine/solver';
import type { GameState } from '../engine/types';

const baseCtx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };

/** 最終盤面（フィールドのカード）を表す文字列。同じ盤面に向かうルートか調べるため */
function finalKey(s: GameState): string {
  return [...s.mz, ...s.emz, ...s.stz, s.fz]
    .filter((u): u is string => !!u)
    .map((u) => s.cards[u].defId)
    .sort()
    .join(',');
}

self.onmessage = (e: MessageEvent<{ state: GameState; deckName: string; maxNodes?: number; noOppAI?: boolean }>) => {
  // CPU戦のCPUのルート：相手（プレイヤー）の妨害は自動で使わない前提で探す
  const ctx: Ctx = e.data.noOppAI ? { ...baseCtx, options: { ...baseCtx.options, oppAI: false } } : baseCtx;
  const found = solveBest(e.data.state, ctx, TOON_EVALUATOR, {
    maxRoutes: 5,
    maxNodes: e.data.maxNodes,
    onProgress: (ratio) => self.postMessage({ type: 'progress', ratio: ratio * 0.9 }),
  });
  // 記事などのルート（探索の深さでは届かない長い展開）も今の盤面から最後まで動ければ候補に入れる
  const fromGuides = GUIDES.filter((g) => g.deckName === e.data.deckName)
    .map((g) => routeFromGuide(e.data.state, ctx, g, TOON_EVALUATOR))
    .filter((r): r is Route => !!r);
  // 最終盤面が同じものは1つにまとめ、妨害の数が多い順に並べる
  const seen = new Set<string>();
  const routes = [...fromGuides, ...found]
    .map((r) => ({ r, disruptions: TOON_EVALUATOR.disruptions!(r.final, ctx), key: finalKey(r.final) }))
    .sort((a, b) => b.disruptions.length - a.disruptions.length || b.r.score - a.r.score)
    .filter((x) => !seen.has(x.key) && !!seen.add(x.key))
    .slice(0, 5);
  self.postMessage({
    type: 'done',
    routes: routes.map(({ r, disruptions, key }) => ({
      title: r.title,
      score: r.score,
      summary: r.summary,
      steps: r.steps,
      disruptions,
      finalKey: key,
      // 最終盤面に残るカード（解説で「最後まで残る」と伝えるため）
      finalUids: [...r.final.mz, ...r.final.emz, ...r.final.stz, r.final.fz].filter((u): u is string => !!u),
    })),
  });
};
