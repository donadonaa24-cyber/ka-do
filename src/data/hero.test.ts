import { describe, expect, it } from 'vitest';
import {
  afterPick,
  completeStep,
  type RunResult,
  type Running,
  startEffect,
  stepCandidates,
} from '../engine/effectRunner';
import { type Action, applyAction, createGame, type Ctx, type MonsterLocation } from '../engine/game';
import type { GameState, Location } from '../engine/types';
import { deckProblems } from '../ui/deckStore';
import { routeFromGuide, guideStepSkipped, findGuideAction } from '../engine/guide';
import { CARD_DB, CARD_SCRIPTS, HERO_DECK } from '.';
import { HERO_GUIDES } from './heroGuides';
import { TOON_EVALUATOR } from './toonEval';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const name = (s: GameState, u: string) => CARD_DB[s.cards[u].defId]?.name ?? s.tokenDefs?.[s.cards[u].defId]?.name;
const find = (s: GameState, zone: 'deck' | 'gy' | 'extra' | 'hand' | 'banished', n: string) =>
  s[zone].find((u) => name(s, u) === n)!;
const mz = (index: number): MonsterLocation => ({ zone: 'mz', index });

function act(s: GameState, a: Action): GameState {
  const r = applyAction(s, a, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

/** 効果を発動し、choices の順に選んで最後まで処理する。失敗したらエラー文を返す */
function tryEffect(
  s: GameState,
  uid: string,
  label: string,
  choices: { pick?: string[]; zone?: Location; mode?: number }[] = [],
): GameState | string {
  const effect = CARD_SCRIPTS[s.cards[uid].defId].effects!.find((e) => e.label.includes(label));
  if (!effect) throw new Error(`効果がありません: ${label}`);
  let r: RunResult = startEffect(s, ctx, uid, effect);
  for (const c of choices) {
    if (r.kind !== 'running') break;
    const run: Running = r.run;
    if (c.pick) {
      const cands = stepCandidates(run, ctx);
      const picked: string[] = [];
      for (const n of c.pick) {
        const u = cands.find((x) => name(run.temp, x) === n && !picked.includes(x));
        if (!u) throw new Error(`候補にありません: ${n}（候補: ${cands.map((x) => name(run.temp, x)).join('、')}）`);
        picked.push(u);
      }
      r = afterPick({ ...run, picked }, ctx);
      if (r.kind === 'running' && c.mode !== undefined) r = afterPick({ ...r.run, mode: c.mode }, ctx);
      if (r.kind === 'running' && r.run.stage === 'zone' && c.zone) r = completeStep(r.run, ctx, c.zone);
    } else if (c.zone) {
      r = completeStep(run, ctx, c.zone);
    }
  }
  if (r.kind === 'error') return r.error;
  if (r.kind === 'running') throw new Error(`効果処理が終わっていません（step ${r.run.stepIndex}）`);
  const done = applyAction(s, r.action, ctx);
  return done.ok ? done.state : done.error;
}
function useEffect(...args: Parameters<typeof tryEffect>): GameState {
  const r = tryEffect(...args);
  if (typeof r === 'string') throw new Error(r);
  return r;
}
const emz = (index: number) => ({ zone: 'emz' as const, index });
const hand = (s: GameState) => s.hand.map((u) => name(s, u));
const field = (s: GameState) => [...s.mz, ...s.emz].filter((u): u is string => !!u).map((u) => name(s, u));
const link = (s: GameState, n: string, materials: string[], to: MonsterLocation | ReturnType<typeof emz>) =>
  act(s, {
    type: 'PROCEDURE_SUMMON',
    method: 'link',
    uid: find(s, 'extra', n),
    materials: materials.map((m) => [...s.mz, ...s.emz].find((u) => u && name(s, u) === m)!),
    to,
  });
const normalSummon = (s: GameState, n: string, index: number) =>
  act(s, { type: 'NORMAL_SUMMON', uid: find(s, 'hand', n), index, tributes: [] });
const onField = (s: GameState, n: string) => [...s.mz, ...s.emz].find((u) => u && name(s, u) === n)!;
// 初手（ルートに関係ない手札誘発で埋める）
const FILLER = ['14558127', '14558127', '23434538', '10045474'];

describe('ＨＥＲＯ', () => {
  it('デッキはメイン40枚・EX13枚で登録できる', () => {
    expect(deckProblems(HERO_DECK, CARD_DB)).toEqual([]);
    expect(HERO_DECK.main).toHaveLength(40);
  });

  it('ルート1：サバティエル→フュージョン・デステニー→クロスガイ→ヘル・デバイサー→カオス＋マスク・チェンジ', () => {
    let s = createGame(HERO_DECK, ctx, 1, ['40237839', ...FILLER]);
    s = useEffect(s, find(s, 'hand', 'ハネクリボー・サバティエル ＬＶ１０'), '①', [
      { pick: ['フュージョン・デステニー'] },
    ]);
    expect(s.lp).toBe(4000);
    expect(hand(s)).toContain('フュージョン・デステニー');
    s = useEffect(s, find(s, 'hand', 'フュージョン・デステニー'), '発動', [
      { pick: ['Ｄ－ＨＥＲＯ デストロイフェニックスガイ'] },
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ', 'Ｍ・ＨＥＲＯ ファーネス'], zone: mz(2) },
    ]);
    expect(name(s, s.mz[2]!)).toBe('Ｄ－ＨＥＲＯ デストロイフェニックスガイ');
    s = useEffect(s, find(s, 'gy', 'Ｄ－ＨＥＲＯ ディアボリックガイ'), '①', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'], zone: mz(1) },
    ]);
    s = link(
      s,
      'Ｘ・ＨＥＲＯ クロスガイ',
      ['Ｄ－ＨＥＲＯ ディアボリックガイ', 'Ｄ－ＨＥＲＯ デストロイフェニックスガイ'],
      emz(0),
    );
    s = useEffect(s, onField(s, 'Ｘ・ＨＥＲＯ クロスガイ'), '①', [
      { pick: ['Ｄ－ＨＥＲＯ デストロイフェニックスガイ'] },
      { zone: mz(2) },
    ]);
    s = useEffect(s, find(s, 'gy', 'Ｄ－ＨＥＲＯ ディアボリックガイ'), '①', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'], zone: mz(0) },
    ]);
    s = useEffect(s, onField(s, 'Ｘ・ＨＥＲＯ クロスガイ'), '②', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'] },
      { pick: ['Ｖ・ＨＥＲＯ ヴァイオン'] },
    ]);
    s = normalSummon(s, 'Ｖ・ＨＥＲＯ ヴァイオン', 1);
    s = useEffect(s, onField(s, 'Ｖ・ＨＥＲＯ ヴァイオン'), '①', [{ pick: ['Ｅ・ＨＥＲＯ シャドー・ミスト'] }]);
    s = useEffect(s, find(s, 'gy', 'Ｅ・ＨＥＲＯ シャドー・ミスト'), '②', [{ pick: ['Ｍ・ＨＥＲＯ ダスク・クロウ'] }]);
    s = useEffect(s, onField(s, 'Ｖ・ＨＥＲＯ ヴァイオン'), '②', [
      { pick: ['Ｅ・ＨＥＲＯ シャドー・ミスト'] },
      { pick: ['融合'] },
    ]);
    s = link(s, 'Ｘ・ＨＥＲＯ ヘル・デバイサー', ['Ｖ・ＨＥＲＯ ヴァイオン', 'Ｘ・ＨＥＲＯ クロスガイ'], emz(0));
    s = useEffect(s, onField(s, 'Ｘ・ＨＥＲＯ ヘル・デバイサー'), '①', [
      { pick: ['Ｅ・ＨＥＲＯ シャイニング・ネオス・ウィングマン'] },
      { pick: ['Ｅ・ＨＥＲＯ ネオス'] },
    ]);
    s = useEffect(s, find(s, 'hand', 'Ｍ・ＨＥＲＯ ダスク・クロウ'), '①', [
      { pick: ['Ｘ・ＨＥＲＯ クロスガイ'] },
      { zone: mz(1) },
    ]);
    s = useEffect(s, onField(s, 'Ｍ・ＨＥＲＯ ダスク・クロウ'), '②', [{ pick: ['Ｍ・ＨＥＲＯ ファウンティン'] }]);
    s = useEffect(s, find(s, 'hand', '融合'), '発動', [
      { pick: ['Ｃ・ＨＥＲＯ カオス'] },
      { pick: ['Ｍ・ＨＥＲＯ ダスク・クロウ', 'Ｍ・ＨＥＲＯ ファウンティン'], zone: mz(1) },
    ]);
    s = useEffect(s, find(s, 'gy', 'Ｍ・ＨＥＲＯ ファウンティン'), '②', [
      { pick: ['マスク・チェンジ'], zone: { zone: 'stz', index: 1 } },
    ]);
    expect(field(s).sort()).toEqual(
      ['Ｃ・ＨＥＲＯ カオス', 'Ｄ－ＨＥＲＯ デストロイフェニックスガイ', 'Ｘ・ＨＥＲＯ ヘル・デバイサー'].sort(),
    );
    const mask = s.stz[1]!;
    expect(name(s, mask)).toBe('マスク・チェンジ');
    // 相手ターンにマスク・チェンジ：ヘル・デバイサーを墓地へ送り、ダーク・ロウを特殊召喚
    s = act(s, { type: 'END_TURN', toOpponent: true });
    s = useEffect(s, mask, '発動', [
      { pick: ['Ｘ・ＨＥＲＯ ヘル・デバイサー'] },
      { pick: ['Ｍ・ＨＥＲＯ ダーク・ロウ'], zone: mz(3) },
    ]);
    expect(name(s, s.mz[3]!)).toBe('Ｍ・ＨＥＲＯ ダーク・ロウ');
    // フュージョン・デステニーで出したモンスターは次のターンのエンドフェイズに破壊される（クロスガイで蘇生したものは別）
    expect(field(s)).toContain('Ｄ－ＨＥＲＯ デストロイフェニックスガイ');
  });

  it('ルート2：ヒーローアライブ→サンライザー→ワンダー・ドライバー→フレイム・シュート→クロスガイ→カオス', () => {
    let s = createGame(HERO_DECK, ctx, 1, ['8949584', ...FILLER]);
    s = useEffect(s, find(s, 'hand', 'ヒーローアライブ'), '発動', [{ pick: ['Ｅ・ＨＥＲＯ エアーマン'], zone: mz(2) }]);
    s = useEffect(s, onField(s, 'Ｅ・ＨＥＲＯ エアーマン'), '①● 召喚・特殊召喚した時：デッキから', [
      { pick: ['Ｖ・ＨＥＲＯ ヴァイオン'] },
    ]);
    s = normalSummon(s, 'Ｖ・ＨＥＲＯ ヴァイオン', 3);
    s = useEffect(s, onField(s, 'Ｖ・ＨＥＲＯ ヴァイオン'), '①', [{ pick: ['Ｅ・ＨＥＲＯ シャドー・ミスト'] }]);
    s = useEffect(s, find(s, 'gy', 'Ｅ・ＨＥＲＯ シャドー・ミスト'), '②', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'] },
    ]);
    s = useEffect(s, onField(s, 'Ｖ・ＨＥＲＯ ヴァイオン'), '②', [
      { pick: ['Ｅ・ＨＥＲＯ シャドー・ミスト'] },
      { pick: ['融合'] },
    ]);
    s = useEffect(s, find(s, 'hand', '融合'), '発動', [
      { pick: ['Ｅ・ＨＥＲＯ サンライザー'] },
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ', 'Ｅ・ＨＥＲＯ エアーマン'], zone: mz(2) },
    ]);
    s = useEffect(s, onField(s, 'Ｅ・ＨＥＲＯ サンライザー'), '①', [{ pick: ['ミラクル・フュージョン'] }]);
    s = link(s, 'Ｘ・ＨＥＲＯ ヘル・デバイサー', ['Ｅ・ＨＥＲＯ サンライザー', 'Ｖ・ＨＥＲＯ ヴァイオン'], emz(0));
    s = useEffect(s, onField(s, 'Ｘ・ＨＥＲＯ ヘル・デバイサー'), '①', [
      { pick: ['Ｅ・ＨＥＲＯ シャイニング・ネオス・ウィングマン'] },
      { pick: ['Ｅ・ＨＥＲＯ ネオス'] },
    ]);
    s = useEffect(s, find(s, 'gy', 'Ｄ－ＨＥＲＯ ディアボリックガイ'), '①', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'], zone: mz(0) },
    ]);
    s = link(
      s,
      'Ｘ・ＨＥＲＯ ワンダー・ドライバー',
      ['Ｄ－ＨＥＲＯ ディアボリックガイ', 'Ｘ・ＨＥＲＯ ヘル・デバイサー'],
      emz(0),
    );
    // 3体目のディアボリックガイをワンダー・ドライバーのリンク先（下）に出す
    s = useEffect(s, find(s, 'gy', 'Ｄ－ＨＥＲＯ ディアボリックガイ'), '①', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'], zone: mz(1) },
    ]);
    s = useEffect(s, onField(s, 'Ｘ・ＨＥＲＯ ワンダー・ドライバー'), '①', [
      { pick: ['融合'] },
      { zone: { zone: 'stz', index: 0 } },
    ]);
    const setPoly = s.stz[0]!;
    expect(s.cards[setPoly].faceUp).toBe(false);
    s = useEffect(s, setPoly, '発動', [
      { pick: ['Ｄ－ＨＥＲＯ デストロイフェニックスガイ'] },
      { pick: ['Ｅ・ＨＥＲＯ ネオス', 'Ｄ－ＨＥＲＯ ディアボリックガイ'], zone: mz(1) },
    ]);
    s = useEffect(s, find(s, 'hand', 'ミラクル・フュージョン'), '発動', [
      { pick: ['Ｅ・ＨＥＲＯ フレイム・ウィングマン－フレイム・シュート'] },
      { pick: ['Ｅ・ＨＥＲＯ ネオス', 'Ｅ・ＨＥＲＯ エアーマン'], zone: mz(2) },
    ]);
    const fs = onField(s, 'Ｅ・ＨＥＲＯ フレイム・ウィングマン－フレイム・シュート');
    s = useEffect(s, fs, '①', [{ pick: ['フェイバリット・コンタクト'] }]);
    s = useEffect(s, fs, '②', [{ pick: ['Ｅ・ＨＥＲＯ エアーマン'], zone: mz(2) }]);
    s = useEffect(s, onField(s, 'Ｅ・ＨＥＲＯ エアーマン'), '①● 召喚・特殊召喚した時：デッキから', [
      { pick: ['Ｍ・ＨＥＲＯ ファーネス'] },
    ]);
    s = useEffect(s, find(s, 'hand', 'Ｍ・ＨＥＲＯ ファーネス'), '①', [
      { pick: ['融合'] },
      { pick: ['Ｍ・ＨＥＲＯ ファーネス'] },
    ]);
    s = link(s, 'Ｘ・ＨＥＲＯ クロスガイ', ['Ｅ・ＨＥＲＯ エアーマン', 'Ｘ・ＨＥＲＯ ワンダー・ドライバー'], emz(0));
    s = useEffect(s, onField(s, 'Ｘ・ＨＥＲＯ クロスガイ'), '①', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'] },
      { zone: mz(0) },
    ]);
    s = useEffect(s, onField(s, 'Ｘ・ＨＥＲＯ クロスガイ'), '②', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'] },
      { pick: ['Ｍ・ＨＥＲＯ ダスク・クロウ'] },
    ]);
    s = useEffect(s, find(s, 'hand', 'Ｍ・ＨＥＲＯ ダスク・クロウ'), '①', [
      { pick: ['Ｖ・ＨＥＲＯ ヴァイオン'] },
      { zone: mz(0) },
    ]);
    s = useEffect(s, onField(s, 'Ｍ・ＨＥＲＯ ダスク・クロウ'), '②', [{ pick: ['Ｍ・ＨＥＲＯ ファウンティン'] }]);
    s = useEffect(s, find(s, 'hand', '融合'), '発動', [
      { pick: ['Ｃ・ＨＥＲＯ カオス'] },
      { pick: ['Ｍ・ＨＥＲＯ ダスク・クロウ', 'Ｍ・ＨＥＲＯ ファウンティン'], zone: mz(0) },
    ]);
    s = useEffect(s, find(s, 'gy', 'Ｍ・ＨＥＲＯ ファウンティン'), '②', [
      { pick: ['マスク・チェンジ'], zone: { zone: 'stz', index: 1 } },
    ]);
    s = act(s, { type: 'SET_SPELL_TRAP', uid: find(s, 'hand', 'フェイバリット・コンタクト'), index: 2 });
    expect(field(s).sort()).toEqual(
      ['Ｃ・ＨＥＲＯ カオス', 'Ｄ－ＨＥＲＯ デストロイフェニックスガイ', 'Ｘ・ＨＥＲＯ クロスガイ'].sort(),
    );
  });

  it.each(HERO_GUIDES.map((g) => [g.name, g] as const))('ナビ：%s を最後まで進められる', (_, guide) => {
    let s = createGame(HERO_DECK, ctx, guide.seed, guide.fixedHand);
    for (const step of guide.steps) {
      if (guideStepSkipped(s, ctx, step)) continue;
      const a = findGuideAction(s, ctx, step);
      if (!a) throw new Error(`見つからない手：${step.text}`);
      s = act(s, a);
    }
    const route = routeFromGuide(createGame(HERO_DECK, ctx, guide.seed, guide.fixedHand), ctx, guide, TOON_EVALUATOR);
    expect(route).not.toBeNull();
    expect(field(route!.final)).toContain('Ｃ・ＨＥＲＯ カオス');
    expect(field(route!.final)).toContain('Ｄ－ＨＥＲＯ デストロイフェニックスガイ');
    expect(field(route!.final)).not.toContain('Ｄ－ＨＥＲＯ ディアボリックガイ');
    expect(hand(route!.final)).not.toContain('Ｍ・ＨＥＲＯ ファーネス');
    expect(route!.final.stz.some((u) => u && name(route!.final, u) === 'マスク・チェンジ')).toBe(true);
  });

  it('フュージョン・デステニーで出したモンスターは次のターンのエンドフェイズに破壊される', () => {
    let s = createGame(HERO_DECK, ctx, 1, ['52947044', ...FILLER]);
    s = useEffect(s, find(s, 'hand', 'フュージョン・デステニー'), '発動', [
      { pick: ['Ｄ－ＨＥＲＯ デストロイフェニックスガイ'] },
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ', 'Ｍ・ＨＥＲＯ ファーネス'], zone: mz(2) },
    ]);
    const dpg = s.mz[2]!;
    // このターンは闇属性の「ＨＥＲＯ」しか特殊召喚できない（エアーマンは風属性）
    expect(
      tryEffect(s, find(s, 'gy', 'Ｄ－ＨＥＲＯ ディアボリックガイ'), '①', [
        { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'], zone: mz(1) },
      ]),
    ).not.toBeTypeOf('string');
    s = act(s, { type: 'NEXT_PHASE', to: 'EP' });
    expect(s.mz[2]).toBe(dpg);
    s = act(s, { type: 'END_TURN', toOpponent: true });
    s = act(s, { type: 'NEXT_PHASE', to: 'EP' });
    expect(s.gy).toContain(dpg);
  });

  it('デストロイフェニックスガイ②：自分のカード1枚とフィールドのカード1枚を破壊。③：次のターンに墓地の「Ｄ－ＨＥＲＯ」を特殊召喚', () => {
    let s = createGame(HERO_DECK, ctx, 1, FILLER);
    s = act(s, {
      type: 'SPECIAL_SUMMON',
      uid: find(s, 'extra', 'Ｄ－ＨＥＲＯ デストロイフェニックスガイ'),
      to: mz(0),
      free: true,
    });
    s = act(s, { type: 'SPECIAL_SUMMON', uid: find(s, 'deck', 'Ｄ－ＨＥＲＯ ディアボリックガイ'), to: mz(1) });
    const dpg = s.mz[0]!;
    s = useEffect(s, dpg, '②', [
      { pick: ['Ｄ－ＨＥＲＯ デストロイフェニックスガイ'] },
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'] },
    ]);
    expect(s.gy).toContain(dpg);
    s = useEffect(s, dpg, '③ 戦闘・効果で破壊された');
    expect(tryEffect(s, dpg, '③の続き')).toMatch('次のターン');
    s = act(s, { type: 'END_TURN' });
    s = act(s, { type: 'NEXT_PHASE' });
    s = useEffect(s, dpg, '③の続き', [{ pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'], zone: mz(0) }]);
    expect(name(s, s.mz[0]!)).toBe('Ｄ－ＨＥＲＯ ディアボリックガイ');
  });

  it('ダーク・ロウは融合召喚できず、マスク・チェンジでのみ特殊召喚できる', () => {
    let s = createGame(HERO_DECK, ctx, 1, FILLER);
    const law = find(s, 'extra', 'Ｍ・ＨＥＲＯ ダーク・ロウ');
    expect(applyAction(s, { type: 'SPECIAL_SUMMON', uid: law, to: mz(0) }, ctx).ok).toBe(false);
    s = act(s, { type: 'SPECIAL_SUMMON', uid: find(s, 'deck', 'Ｄ－ＨＥＲＯ ディアボリックガイ'), to: mz(0) });
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', 'マスク・チェンジ'), to: { zone: 'hand' } });
    s = useEffect(s, find(s, 'hand', 'マスク・チェンジ'), '発動', [
      { pick: ['Ｄ－ＨＥＲＯ ディアボリックガイ'] },
      { pick: ['Ｍ・ＨＥＲＯ ダーク・ロウ'], zone: mz(1) },
    ]);
    expect(name(s, s.mz[1]!)).toBe('Ｍ・ＨＥＲＯ ダーク・ロウ');
    expect(s.cards[s.mz[1]!].properlySummoned).toBe(true);
  });

  it('フェイバリット・コンタクト：墓地・除外の素材をデッキの下に戻し、融合モンスターを召喚条件を無視して特殊召喚', () => {
    let s = createGame(HERO_DECK, ctx, 1, FILLER);
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', 'Ｍ・ＨＥＲＯ ダスク・クロウ'), to: { zone: 'gy' } });
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', 'Ｍ・ＨＥＲＯ ファウンティン'), to: { zone: 'banished' } });
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', 'フェイバリット・コンタクト'), to: { zone: 'hand' } });
    const fc = find(s, 'hand', 'フェイバリット・コンタクト');
    s = act(s, { type: 'SET_SPELL_TRAP', uid: fc, index: 0 });
    s = act(s, { type: 'END_TURN', toOpponent: true });
    s = useEffect(s, fc, '発動', [
      { pick: ['Ｃ・ＨＥＲＯ カオス'] },
      { pick: ['Ｍ・ＨＥＲＯ ダスク・クロウ', 'Ｍ・ＨＥＲＯ ファウンティン'], zone: mz(0) },
    ]);
    expect(name(s, s.mz[0]!)).toBe('Ｃ・ＨＥＲＯ カオス');
    expect(
      s.deck
        .slice(-2)
        .map((u) => name(s, u))
        .sort(),
    ).toEqual(['Ｍ・ＨＥＲＯ ダスク・クロウ', 'Ｍ・ＨＥＲＯ ファウンティン'].sort());
  });

  it('ファーネス②：炎属性以外の「ＨＥＲＯ」融合モンスターを特殊召喚したら手札から特殊召喚、離れると除外', () => {
    let s = createGame(HERO_DECK, ctx, 1, FILLER);
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', 'Ｍ・ＨＥＲＯ ファーネス'), to: { zone: 'hand' } });
    const furnace = find(s, 'hand', 'Ｍ・ＨＥＲＯ ファーネス');
    expect(tryEffect(s, furnace, '②', [{ zone: mz(1) }])).toMatch('特殊召喚していません');
    s = act(s, {
      type: 'SPECIAL_SUMMON',
      uid: find(s, 'extra', 'Ｄ－ＨＥＲＯ デストロイフェニックスガイ'),
      to: mz(0),
      as: 'fusion',
    });
    s = useEffect(s, furnace, '②', [{ zone: mz(1) }]);
    expect(s.mz[1]).toBe(furnace);
    s = act(s, { type: 'MOVE', uid: furnace, to: { zone: 'gy' }, reason: '効果で破壊' });
    expect(s.banished).toContain(furnace);
  });
});
