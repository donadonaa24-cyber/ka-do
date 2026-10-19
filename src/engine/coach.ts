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
  /** この手で効果を使う・召喚するカード */
  actor?: string;
  /** この手で動くカード（サーチしたカード・素材など） */
  uids: string[];
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
  /** 最終盤面に残るカード */
  finalUids: string[];
}

/** ゾーン番号の違いは同じ手とみなす */
export function normalize(text: string): string {
  // 特殊召喚の表示形式はプレイヤーが選べるので、ルートと違っても同じ手順とみなす
  return text
    .replace(/[0-9]/g, '')
    .replace(/\((左|右)\)/g, '')
    .replace(/(攻撃|守備)表示で特殊召喚/g, '表示で特殊召喚');
}

/** 「Aの効果「①…」を発動」を「A ①…」に縮める */
export function shortLine(line: string): string {
  const clean = line.replace('（処理後に「解決」で墓地へ）', '');
  const m = clean.match(/^(.+?)の効果「(.+)」を発動$/);
  return m ? `${m[1]}：${m[2]}` : clean;
}

export function coachFromRoute(
  title: string,
  steps: RouteStep[],
  summary: string[],
  baseLog: number,
  finalUids: string[] = [],
): Coach {
  return {
    kind: 'route',
    title,
    summary,
    baseLog,
    finalUids,
    steps: steps.map((s) => ({
      text: s.note ?? shortLine(s.lines[0] ?? ''),
      sub: (s.note ? s.lines : s.lines.slice(1)).filter((l) => !l.includes('効果処理完了')),
      match: s.lines.map(normalize),
      action: s.action,
      actor: actorOf(s.action),
      uids: actionUids(s.action),
    })),
  };
}

/** 操作で使う・動くカードを全部集める */
export function actionUids(action: Action): string[] {
  const out: string[] = [];
  const visit = (a: Action) => {
    if (a.type === 'BATCH') return a.actions.forEach(visit);
    if ('uid' in a && a.uid) out.push(a.uid);
    if ('tributes' in a && a.tributes) out.push(...a.tributes);
    if ('materials' in a) out.push(...a.materials);
    if ('target' in a && typeof a.target === 'string') out.push(a.target);
  };
  visit(action);
  return [...new Set(out)];
}

/** その手の主役のカード（効果を使う・召喚する・セットする） */
export function actorOf(action: Action): string | undefined {
  if (action.type === 'BATCH') return action.actions.length ? actorOf(action.actions[0]) : undefined;
  return 'uid' in action ? action.uid : undefined;
}

/**
 * 「なぜこの手をするのか」の説明。この手で動いたカードが、後のどの手で使われるか・最後まで残るかを示す。
 * nameOf はカードの名前を返す。
 */
export function explainStep(coach: Coach, index: number, nameOf: (uid: string) => string): string[] {
  const step = coach.steps[index];
  if (!step) return [];
  const out: string[] = [];
  const laterUse = (uid: string) =>
    coach.steps.findIndex((s, j) => j > index && (s.actor === uid || s.uids.includes(uid)));
  const seen = new Set<string>();
  for (const uid of [step.actor, ...step.uids].filter((u): u is string => !!u)) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    const j = laterUse(uid);
    const name = `《${nameOf(uid)}》`;
    if (j >= 0) {
      out.push(`${name}は手順${j + 1}で${roleIn(coach.steps[j], uid)}`);
    } else if (coach.finalUids.includes(uid)) {
      out.push(`${name}は最終盤面に残ります`);
    }
  }
  if (out.length === 0 && step.actor) out.push(`《${nameOf(step.actor)}》の効果で展開を進めます`);
  return out;
}

/** 後の手でそのカードが何をするか */
function roleIn(step: CoachStep, uid: string): string {
  const a = step.action?.type === 'BATCH' ? step.action.actions[0] : step.action;
  if (step.actor !== uid) return '素材・コストになります';
  switch (a?.type) {
    case 'NORMAL_SUMMON':
      return '召喚します';
    case 'PROC_SUMMON':
    case 'PROCEDURE_SUMMON':
    case 'SPECIAL_SUMMON':
      return '特殊召喚します';
    case 'SET_SPELL_TRAP':
      return 'セットします';
    case 'ACTIVATE_CARD':
      return '発動します';
    default:
      return '効果を使います';
  }
}

export function coachFromGuide(g: Guide): Coach {
  return {
    kind: 'guide',
    title: g.name,
    summary: g.notes,
    baseLog: 0,
    finalUids: [],
    guideId: g.id,
    steps: g.steps.map((s) => ({ text: s.text, sub: [], match: s.match.map(normalize), uids: [] })),
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
