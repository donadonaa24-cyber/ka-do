import { type Action, applyAction, type Ctx } from './game';
import { enumerateActions } from './solver';
import type { GameState } from './types';

/** 手順ガイドの1手。ログにこの文言が全て出る操作をその手とみなす */
export interface GuideStep {
  text: string;
  match: string[];
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
  return step.match.every((m) => logText.includes(m));
}

/** 今の盤面からガイドの手順に当たる操作を探す */
export function findGuideAction(state: GameState, ctx: Ctx, step: GuideStep): Action | null {
  const strictCtx: Ctx = { ...ctx, options: { ...ctx.options, strict: true } };
  for (const action of enumerateActions(state, strictCtx)) {
    const r = applyAction(state, action, strictCtx);
    if (r.ok && stepMatches(step, newLogText(state, r.state))) return action;
  }
  return null;
}
