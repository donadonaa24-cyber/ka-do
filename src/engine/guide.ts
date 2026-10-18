import { type Action, applyAction, type Ctx } from './game';
import { enumerateActions, type Evaluator, type Route, type RouteStep, stepLines } from './solver';
import type { GameState } from './types';

/** 手順ガイドの1手。ログにこの文言が全て出る操作をその手とみなす */
export interface GuideStep {
  text: string;
  match: string[];
  /** ログにこの文言が出る操作は除く（素材の選び方を区別するため） */
  exclude?: string[];
  /** このカード名のカードが手札にあれば、この手は飛ばす（「賢士が手札にあればサーチ不要」など） */
  skipIfInHand?: string;
}

/** 今の手札ではこの手を飛ばすか */
export function guideStepSkipped(state: GameState, ctx: Ctx, step: GuideStep): boolean {
  return !!step.skipIfInHand && state.hand.some((u) => ctx.db[state.cards[u].defId]?.name === step.skipIfInHand);
}

export interface Guide {
  id: string;
  name: string;
  description: string;
  deckName: string;
  seed: number;
  fixedHand: string[];
  steps: GuideStep[];
  /** 最終盤面・補足 */
  notes: string[];
}

export function newLogText(before: GameState, after: GameState): string {
  return after.log
    .slice(before.log.length)
    .map((l) => l.text)
    .join('\n');
}

export function stepMatches(step: GuideStep, logText: string): boolean {
  return step.match.every((m) => logText.includes(m)) && !step.exclude?.some((m) => logText.includes(m));
}

/** 今の盤面からガイドの手順に当たる操作を探す */
export function findGuideAction(state: GameState, ctx: Ctx, step: GuideStep): Action | null {
  const strictCtx: Ctx = { ...ctx, options: { ...ctx.options, strict: true } };
  for (const action of enumerateActions(state, strictCtx, { allZones: true })) {
    const r = applyAction(state, action, strictCtx);
    if (r.ok && stepMatches(step, newLogText(state, r.state))) return action;
  }
  return null;
}

/**
 * ガイドの手順を今の盤面から最後まで実行できれば、探索結果と同じ形のルートにする
 * （探索の深さでは届かない長い展開を「最適ルート」の候補に入れるため）
 */
export function routeFromGuide(state: GameState, ctx: Ctx, guide: Guide, evaluator: Evaluator): Route | null {
  const strictCtx: Ctx = { ...ctx, options: { ...ctx.options, strict: true } };
  let s = state;
  const steps: RouteStep[] = [];
  for (const step of guide.steps) {
    if (guideStepSkipped(s, strictCtx, step)) continue;
    const action = findGuideAction(s, strictCtx, step);
    if (!action) return null;
    const r = applyAction(s, action, strictCtx);
    if (!r.ok) return null;
    steps.push({ action, lines: stepLines(s, r.state), note: step.text });
    s = r.state;
  }
  return {
    title: guide.name,
    steps,
    score: evaluator.score(s, strictCtx),
    final: s,
    summary: evaluator.describe(s, strictCtx),
  };
}
