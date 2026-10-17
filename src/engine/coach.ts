import type { Action } from './game';
import type { Guide } from './guide';
import type { RouteStep } from './solver';
import type { GameState, Location } from './types';

// 練習中の展開（探索したルートかガイド）の「次の手」を管理する。

export interface CoachStep {
  /** 見出し（短い説明） */
  text: string;
  /** 補足（何をどこへ動かすか） */
  sub: string[];
  /** ログにこれが全て出たら、この手が終わったとみなす */
  match: string[];
  /** そのまま実行できる操作（探索したルートのみ。ガイドはその場で探す） */
  action?: Action;
}

export interface Coach {
  kind: 'route' | 'guide';
  title: string;
  steps: CoachStep[];
  /** この練習を始めた時点のログの長さ */
  baseLog: number;
  guideId?: string;
  /** 最終盤面の説明 */
  summary: string[];
}

/** ゾーン番号の違いは同じ手とみなす */
export function normalize(text: string): string {
  return text.replace(/[0-9]/g, '').replace(/\((左|右)\)/g, '');
}

/** 「Aの効果「①…」を発動」を「A ①…」に縮める */
export function shortLine(line: string): string {
  const m = line.match(/^(.+?)の効果「(.+)」を発動$/);
  return m ? `${m[1]}：${m[2]}` : line;
}

export function coachFromRoute(title: string, steps: RouteStep[], summary: string[], baseLog: number): Coach {
  return {
    kind: 'route',
    title,
    summary,
    baseLog,
    steps: steps.map((s) => ({
      text: shortLine(s.lines[0] ?? ''),
      sub: s.lines.slice(1).filter((l) => !l.includes('効果処理完了')),
      match: s.lines.map(normalize),
      action: s.action,
    })),
  };
}

export function coachFromGuide(g: Guide): Coach {
  return {
    kind: 'guide',
    title: g.name,
    summary: g.notes,
    baseLog: 0,
    guideId: g.id,
    steps: g.steps.map((s) => ({ text: s.text, sub: [], match: s.match.map(normalize) })),
  };
}

/** ログを先頭から見て、何手目まで終わっているか */
export function coachProgress(coach: Coach, state: GameState): number {
  const log = state.log.map((l) => normalize(l.text));
  let pos = coach.baseLog;
  let done = 0;
  for (const step of coach.steps) {
    let found = -1;
    let text = '';
    for (let j = pos; j < log.length; j++) {
      text += `${log[j]}\n`;
      if (step.match.every((m) => text.includes(m))) {
        found = j;
        break;
      }
    }
    if (found < 0) break;
    pos = found + 1;
    done++;
  }
  return done;
}

/** 次の手で使うカードと、出し先のゾーン（盤面で光らせる） */
export function actionHighlights(action: Action | undefined): { cards: string[]; zones: Location[] } {
  const cards: string[] = [];
  const zones: Location[] = [];
  const visit = (a: Action) => {
    switch (a.type) {
      case 'BATCH':
        a.actions.forEach(visit);
        return;
      case 'NORMAL_SUMMON':
        cards.push(a.uid, ...(a.tributes ?? []));
        zones.push({ zone: 'mz', index: a.index });
        return;
      case 'SPECIAL_SUMMON':
      case 'PROC_SUMMON':
      case 'PROCEDURE_SUMMON':
        cards.push(a.uid, ...('materials' in a ? a.materials : []));
        zones.push(a.to);
        return;
      case 'ACTIVATE_CARD':
      case 'ACTIVATE_EFFECT':
      case 'SET_SPELL_TRAP':
        cards.push(a.uid);
        if (a.type !== 'ACTIVATE_EFFECT' && a.index !== undefined) zones.push({ zone: 'stz', index: a.index });
        return;
      case 'MOVE':
        if (a.to.zone === 'stz' || a.to.zone === 'fz' || a.to.zone === 'mz' || a.to.zone === 'emz') zones.push(a.to);
        return;
      default:
        return;
    }
  };
  if (action) visit(action);
  // 最初に出てくるカードが「使うカード」
  return { cards: [...new Set(cards)].slice(0, 1), zones };
}
