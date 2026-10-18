import { it } from 'vitest';
import {
  afterPick,
  chainableEffects,
  completeStep,
  currentStep,
  effectAvailable,
  fizzleTop,
  pickRange,
  type RunResult,
  zoneChoices,
  startEffect,
  startResolve,
  stepCandidates,
} from '../engine/effectRunner';
import { type Action, applyAction, createGame, type Ctx, replay } from '../engine/game';
import { mulberry32 } from '../engine/rng';
import { enumerateActions } from '../engine/solver';
import type { GameState } from '../engine/types';
import { BUILTIN_DECKS, CARD_DB, CARD_SCRIPTS, OPP_GENERIC_CARDS } from '.';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const loose: Ctx = { ...ctx, options: { strict: false } };
const name = (s: GameState, u: string) => (s.cards[u] ? (CARD_DB[s.cards[u].defId]?.name ?? s.cards[u].defId) : u);

const issues = new Map<string, { n: number; ex: string }>();
const note = (kind: string, key: string, ex = '') => {
  const k = `[${kind}] ${key}`;
  const cur = issues.get(k);
  if (cur) cur.n++;
  else issues.set(k, { n: 1, ex });
};

function invariant(s: GameState): string | null {
  const seen = new Map<string, number>();
  const add = (u: string | null | undefined) => u && seen.set(u, (seen.get(u) ?? 0) + 1);
  for (const z of [s.deck, s.hand, s.extra, s.gy, s.banished, s.mz, s.emz, s.stz, [s.fz]]) z.forEach(add);
  if (s.opp)
    for (const z of [s.opp.mz, s.opp.emz ?? [], s.opp.stz, [s.opp.fz], s.opp.gy, s.opp.banished, s.opp.hand])
      z.forEach(add);
  for (const u of Object.keys(s.cards)) s.cards[u].overlay.forEach(add);
  for (const [u, n] of seen) if (n > 1) return `重複 ${name(s, u)}`;
  for (const u of Object.keys(s.cards)) if (!seen.has(u)) return `所在不明 ${name(s, u)}`;
  for (const u of seen.keys()) if (!s.cards[u]) return `実体なし ${u}`;
  if (s.mz.length !== 5 || s.stz.length !== 5 || s.emz.length !== 2) return 'ゾーン数';
  return null;
}

/** 効果の処理を画面と同じようにランダムな選択で進める */
function drive(r: RunResult, rnd: () => number, label: string): Action | null {
  for (let guard = 0; guard < 60; guard++) {
    if (r.kind === 'done') return r.action;
    if (r.kind === 'error') {
      note('効果エラー', `${label} → ${r.error}`);
      return null;
    }
    const run = r.run;
    const step = currentStep(run);
    if (run.stage === 'pick') {
      const cands = stepCandidates(run, ctx);
      const [min, max] = pickRange(run, ctx);
      if (cands.length < min) {
        note('進行不能（候補不足）', `${label} / ${step?.op === 'pick' ? step.prompt : ''} 候補${cands.length}<${min}`);
        return null;
      }
      const hi = Math.min(max, cands.length);
      const k = min + Math.floor(rnd() * (hi - min + 1));
      const pool = [...cands];
      const picked: string[] = [];
      for (let i = 0; i < k; i++) picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      r = afterPick({ ...run, picked }, ctx);
    } else if (run.stage === 'mode') {
      const n = step?.op === 'pick' ? (step.modes?.length ?? 1) : 1;
      r = afterPick({ ...run, mode: Math.floor(rnd() * n), stage: 'mode' }, ctx);
    } else {
      const zones = zoneChoices(run);
      if (!zones.length) {
        note('進行不能（ゾーンなし）', `${label} / ${step?.op === 'pick' || step?.op === 'place' ? step.prompt : ''}`);
        return null;
      }
      r = completeStep(run, ctx, zones[Math.floor(rnd() * zones.length)]);
    }
  }
  note('進行不能（ループ）', label);
  return null;
}

function play(deckIndex: number, seed: number, steps: number) {
  const deck = BUILTIN_DECKS[deckIndex];
  const rnd = mulberry32(seed * 7 + deckIndex);
  const init = createGame(deck, ctx, seed);
  let s = init;
  const actions: Action[] = [];
  const apply = (a: Action, label: string): boolean => {
    const r = applyAction(s, a, ctx);
    if (!r.ok) {
      note('操作が失敗', `${label} → ${r.error}`);
      return false;
    }
    const bad = invariant(r.state);
    if (bad) note('不整合', `${label} → ${bad}`, JSON.stringify(a).slice(0, 300));
    s = r.state;
    actions.push(a);
    return true;
  };
  for (let i = 0; i < steps && s.status === 'playing'; i++) {
    try {
      // チェーンがあれば、たまに追加でチェーンし、そうでなければ上から解決する
      if (s.chain.length) {
        const resp = chainableEffects(s, ctx, s.chain[s.chain.length - 1].speed);
        if (resp.length && rnd() < 0.3) {
          const c = resp[Math.floor(rnd() * resp.length)];
          const label = `${deck.name}: チェーン ${name(s, c.uid)}「${c.effect.label}」`;
          const a = drive(startEffect(s, ctx, c.uid, c.effect, undefined, 'force'), rnd, label);
          if (a) apply(a, label);
          continue;
        }
        const top = s.chain[s.chain.length - 1];
        const label = `${deck.name}: 解決 ${CARD_DB[top.defId]?.name}「${top.label}」`;
        const a = drive(startResolve(s, ctx), rnd, label);
        if (a) apply(a, label);
        else {
          // 解決できなければ不発にして続ける
          apply(fizzleTop(s, ctx)!, 'fizzle');
        }
        continue;
      }
      const roll = rnd();
      if (roll < 0.03) {
        apply({ type: 'END_TURN', toOpponent: !s.opponentTurn }, 'ターン終了');
        continue;
      }
      if (roll < 0.06) {
        const g = OPP_GENERIC_CARDS[Math.floor(rnd() * 4)];
        const row =
          g.kind === 'monster'
            ? (s.opp?.mz ?? [null, null, null, null, null])
            : (s.opp?.stz ?? [null, null, null, null, null]);
        const free = [0, 1, 2, 3, 4].filter((i) => !row[i]);
        if (free.length) {
          const index = free[Math.floor(rnd() * free.length)];
          const to = g.kind === 'monster' ? ({ zone: 'omz', index } as const) : ({ zone: 'ostz', index } as const);
          apply({ type: 'OPP_PLACE', defId: g.id, to, faceUp: rnd() < 0.5 }, 'OPP_PLACE');
        }
        continue;
      }
      // 効果（画面のボタンと同じく、使える場所にあるものすべて）
      const effs: { uid: string; e: (typeof CARD_SCRIPTS)[string]['effects'] & object }[] = [];
      const opts: { uid: string; idx: number }[] = [];
      for (const uid of [...s.hand, ...s.mz, ...s.emz, ...s.stz, s.fz, ...s.gy, ...s.banished].filter(
        (u): u is string => !!u,
      )) {
        const es = CARD_SCRIPTS[s.cards[uid].defId]?.effects ?? [];
        es.forEach((e, idx) => {
          if (!e.opponentOnly && effectAvailable(s, uid, e)) opts.push({ uid, idx });
        });
      }
      void effs;
      if (roll < 0.6 && opts.length) {
        const o = opts[Math.floor(rnd() * opts.length)];
        const e = CARD_SCRIPTS[s.cards[o.uid].defId].effects![o.idx];
        const label = `${deck.name}: ${name(s, o.uid)}「${e.label}」`;
        const r = startEffect(s, ctx, o.uid, e, undefined, rnd() < 0.5 ? 'auto' : 'never');
        if (r.kind === 'error') {
          note('発動不可（参考）', `${name(s, o.uid)}「${e.label}」→ ${r.error}`);
          continue;
        }
        const a = drive(r, rnd, label);
        if (a) apply(a, label);
        continue;
      }
      const acts = enumerateActions(s, ctx);
      if (acts.length && rnd() < 0.8) {
        const a = acts[Math.floor(rnd() * acts.length)];
        const label = `${deck.name}: 列挙 ${a.type} ${'uid' in a ? name(s, a.uid as string) : ''}`;
        apply(a, label);
      } else apply({ type: 'NEXT_PHASE' }, 'NEXT_PHASE');
    } catch (e) {
      note('例外', `${deck.name}: ${(e as Error).message}`, (e as Error).stack?.split('\n').slice(0, 4).join(' | '));
      break;
    }
  }
  // リプレイで同じ盤面になるか
  try {
    const again = replay(init, actions, loose);
    const strip = (x: GameState) => JSON.stringify({ ...x, log: x.log.length });
    if (strip(again) !== strip(s)) note('リプレイ不一致', `${deck.name} seed${seed}`);
  } catch (e) {
    note('リプレイ失敗', `${deck.name} seed${seed}: ${(e as Error).message}`);
  }
}

// ランダムに操作して、進行不能・不整合・リプレイ不一致を探す監査。FUZZ_N=40 npx vitest run src/data/fuzz.audit.test.ts
const FUZZ_N = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FUZZ_N;

it.skipIf(!FUZZ_N)('fuzz', { timeout: 600000 }, () => {
  const N = Number(FUZZ_N);
  for (let d = 0; d < BUILTIN_DECKS.length; d++) for (let seed = 1; seed <= N; seed++) play(d, seed, 80);
  const lines = [...issues.entries()]
    .filter(([k]) => !k.startsWith('[発動不可'))
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${v.n}\t${k}${v.ex ? `\n\t\t${v.ex}` : ''}`);
  const ref = [...issues.entries()].filter(([k]) => k.startsWith('[発動不可')).map(([k, v]) => `${v.n}\t${k}`);
  console.log(lines.join('\n'));
  console.log('---- 参考：発動できない理由 ----\n' + ref.sort().join('\n'));
});
