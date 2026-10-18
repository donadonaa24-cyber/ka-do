import { describe, expect, it } from 'vitest';
import {
  afterPick,
  completeStep,
  type RunResult,
  type Running,
  startEffect,
  stepCandidates,
} from '../engine/effectRunner';
import {
  type Action,
  applyAction,
  createGame,
  type Ctx,
  currentLevel,
  findLocation,
  type MonsterLocation,
} from '../engine/game';
import type { GameState, Location } from '../engine/types';
import { deckProblems } from '../ui/deckStore';
import { routeFromGuide } from '../engine/guide';
import { BLUE_EYES_DECK, CARD_DB, CARD_SCRIPTS } from '.';
import { BLUE_GUIDES } from './blueGuides';
import { TOON_EVALUATOR } from './toonEval';

const ctx: Ctx = { db: CARD_DB, options: { strict: true }, scripts: CARD_SCRIPTS };
const name = (s: GameState, u: string) => CARD_DB[s.cards[u].defId].name;
const find = (s: GameState, zone: 'deck' | 'gy' | 'extra' | 'hand', n: string) =>
  s[zone].find((u) => name(s, u) === n)!;
const mz = (index: number): MonsterLocation => ({ zone: 'mz', index });

function act(s: GameState, a: Action): GameState {
  const r = applyAction(s, a, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

/** 効果を発動し、choices の順にカード名（とゾーン・処理の種類）を選んで最後まで解決する。失敗したらエラー文を返す */
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

/** デッキ・墓地などのカードを効果で出したことにする（テストの準備用） */
const put = (s: GameState, uid: string, index: number) => act(s, { type: 'SPECIAL_SUMMON', uid, to: mz(index) });

describe('ブルーアイズ', () => {
  it('デッキはメイン42枚・EX14枚で登録できる', () => {
    expect(BLUE_EYES_DECK.main).toHaveLength(42);
    expect(BLUE_EYES_DECK.extra).toHaveLength(14);
    expect(deckProblems(BLUE_EYES_DECK, CARD_DB)).toEqual([]);
  });

  it('青き眼の賢士②で白き乙女を対象にし、乙女③をチェーン：墓地の青眼→デッキのブルーアイズ', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['8240199']);
    s = put(s, find(s, 'deck', '白き乙女'), 0);
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', '青眼の白龍'), to: { zone: 'gy' } });
    const sage = find(s, 'hand', '青き眼の賢士');
    s = useEffect(s, sage, '白き乙女を対象に', [
      { pick: ['白き乙女'] },
      { pick: ['青眼の白龍'], zone: mz(1) },
      { pick: ['蒼の深淵 ディープアイズ・ホワイト・ドラゴン'], zone: mz(2) },
    ]);
    expect([s.mz[1], s.mz[2]].map((u) => name(s, u!))).toEqual([
      '青眼の白龍',
      '蒼の深淵 ディープアイズ・ホワイト・ドラゴン',
    ]);
    expect(s.gy.map((u) => name(s, u))).toEqual(expect.arrayContaining(['白き乙女', '青き眼の賢士']));
    // 乙女②：墓地に送られた後に青眼の白龍を特殊召喚していないので、まだ使えない
    expect(tryEffect(s, find(s, 'gy', '白き乙女'), '② 墓地にある状態で', [{ zone: mz(3) }])).toMatch(
      /特殊召喚していません/,
    );
  });

  it('カオス・MAXは儀式召喚でしか出せない（賢士②でデッキから出せない）。白き龍の威光②で儀式召喚', () => {
    let a = createGame(BLUE_EYES_DECK, ctx, 1, ['8240199']);
    a = put(a, find(a, 'deck', '白き乙女'), 0);
    const r = tryEffect(a, find(a, 'hand', '青き眼の賢士'), '② 手札から捨て', [
      { pick: ['白き乙女'] },
      { pick: ['ブルーアイズ・カオス・ＭＡＸ・ドラゴン'], zone: mz(1) },
    ]);
    expect(r).toMatch(/儀式召喚でしか/);

    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['55410871', '89631139']);
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', '白き龍の威光'), to: { zone: 'gy' } });
    s = useEffect(s, find(s, 'gy', '白き龍の威光'), '② 墓地から除外', [
      { pick: ['ブルーアイズ・カオス・ＭＡＸ・ドラゴン'] },
      { pick: ['青眼の白龍'], zone: mz(2) },
    ]);
    expect(name(s, s.mz[2]!)).toBe('ブルーアイズ・カオス・ＭＡＸ・ドラゴン');
    expect(s.cards[s.mz[2]!].summonType).toBe('ritual');
  });

  it('究極融合：手札・フィールド・墓地の青眼の白龍3体をデッキに戻して青眼の究極竜', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['71143015', '89631139']);
    s = put(s, find(s, 'deck', '青眼の白龍'), 0);
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', '青眼の白龍'), to: { zone: 'gy' } });
    s = useEffect(s, find(s, 'hand', '究極融合'), '発動', [
      { pick: ['青眼の究極竜'] },
      { pick: ['青眼の白龍', '青眼の白龍', '青眼の白龍'], zone: mz(1) },
    ]);
    expect(name(s, s.mz[1]!)).toBe('青眼の究極竜');
    expect(s.deck.filter((u) => name(s, u) === '青眼の白龍')).toHaveLength(3);
    // 2体だけでは融合できない
    let t = createGame(BLUE_EYES_DECK, ctx, 1, ['71143015', '89631139']);
    t = put(t, find(t, 'deck', '青眼の白龍'), 0);
    expect(() =>
      tryEffect(t, find(t, 'hand', '究極融合'), '発動', [
        { pick: ['青眼の究極竜'] },
        { pick: ['青眼の白龍', '青眼の白龍'] },
      ]),
    ).toThrow();
  });

  it('シーホース②で乙女ではなくシーホース自身のレベルを下げ、チューナー2体＋青眼で青眼の究極霊竜', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, []);
    s = put(s, find(s, 'deck', '白き乙女'), 0);
    s = put(s, find(s, 'deck', 'ネオ・カイザー・シーホース'), 1);
    s = put(s, find(s, 'deck', '青眼の白龍'), 2);
    const seahorse = s.mz[1]!;
    s = useEffect(s, seahorse, '② 自分の光属性チューナー', [{ pick: ['ネオ・カイザー・シーホース'], mode: 1 }]);
    expect(currentLevel(s, ctx, seahorse)).toBe(3);
    s = act(s, {
      type: 'PROCEDURE_SUMMON',
      method: 'synchro',
      uid: find(s, 'extra', '青眼の究極霊竜'),
      materials: [s.mz[0]!, seahorse, s.mz[2]!],
      to: { zone: 'emz', index: 0 },
    });
    expect(name(s, s.emz[0]!)).toBe('青眼の究極霊竜');
    // シーホース③：フィールドから墓地へ送られたので、デッキからブルーアイズを墓地へ送れる
    s = useEffect(s, seahorse, '③ フィールドから墓地へ', [{ pick: ['蒼の深淵 ディープアイズ・ホワイト・ドラゴン'] }]);
    expect(s.gy.map((u) => name(s, u))).toContain('蒼の深淵 ディープアイズ・ホワイト・ドラゴン');
  });

  it('青眼の精霊龍③はシフル（S召喚でしか出せない）を出せず、赤き竜②なら究極霊竜をS召喚扱いで出せる', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, []);
    s = put(s, find(s, 'deck', '白き乙女'), 0);
    s = put(s, find(s, 'deck', '青眼の白龍'), 1);
    s = act(s, {
      type: 'PROCEDURE_SUMMON',
      method: 'synchro',
      uid: find(s, 'extra', '青眼の精霊龍'),
      materials: [s.mz[0]!, s.mz[1]!],
      to: mz(0),
    });
    const spirit = s.mz[0]!;
    expect(
      tryEffect(s, spirit, '③ S召喚したこのカード', [{ pick: ['聖珖神竜 スターダスト・シフル'], zone: mz(1) }]),
    ).toMatch(/シンクロ召喚でしか/);
    s = useEffect(s, spirit, '③ S召喚したこのカード', [{ pick: ['赤き竜'], zone: mz(1) }]);
    expect(s.cards[s.mz[1]!].destroyAtEnd).toBe(true);
    // 赤き竜は精霊龍③で出したのでS召喚扱いではないが、②は使える（レベル12の究極霊竜を対象にはできないので、別のSを用意）
    let t = createGame(BLUE_EYES_DECK, ctx, 1, []);
    t = put(t, find(t, 'extra', '赤き竜'), 0);
    t = put(t, find(t, 'extra', '青眼の精霊龍'), 1);
    t = useEffect(t, t.mz[0]!, '② 自分のレベル7以上', [
      { pick: ['青眼の精霊龍'] },
      { pick: ['ライトストーム・ドラゴン'], zone: mz(2) },
    ]);
    expect(name(t, t.mz[2]!)).toBe('ライトストーム・ドラゴン');
    expect(t.cards[t.mz[2]!].summonType).toBe('synchro');
    expect(t.extra.map((u) => name(t, u))).toContain('赤き竜');
  });

  it('青き眼の祈り②で融合モンスターを装備した青眼の白龍をリリースし、タイラントを特殊召喚', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, []);
    s = put(s, find(s, 'deck', '青眼の白龍'), 0);
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', '青き眼の祈り'), to: { zone: 'gy' } });
    s = useEffect(s, find(s, 'gy', '青き眼の祈り'), '② 墓地から除外', [
      { pick: ['青眼の白龍'] },
      { pick: ['青眼の究極竜'] },
    ]);
    const equip = s.stz.find((u) => u && name(s, u) === '青眼の究極竜')!;
    expect(s.cards[equip].equippedTo).toBe(s.mz[0]);
    const tyrant = find(s, 'extra', 'ブルーアイズ・タイラント・ドラゴン');
    s = act(s, { type: 'PROC_SUMMON', uid: tyrant, proc: 0, materials: [s.mz[0]!], to: mz(0) });
    expect(name(s, s.mz[0]!)).toBe('ブルーアイズ・タイラント・ドラゴン');
    // 装備していた究極竜は墓地へ。正規の召喚をしていないので墓地から特殊召喚できない
    expect(findLocation(s, equip)).toEqual({ zone: 'gy' });
    expect(applyAction(s, { type: 'SPECIAL_SUMMON', uid: equip, to: mz(1) }, ctx)).toMatchObject({ ok: false });
  });

  it('カイバーマン①で青眼の白龍を出すと、墓地の白き乙女②・カイバーマン②が使える', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['67768675']);
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', '白き乙女'), to: { zone: 'gy' } });
    s = act(s, { type: 'NORMAL_SUMMON', uid: find(s, 'hand', '正義の伝説 カイバーマン'), index: 0 });
    const kaiba = s.mz[0]!;
    s = useEffect(s, kaiba, '① 召喚・特殊召喚時', [{ pick: ['青眼の白龍'], zone: mz(1) }]);
    s = useEffect(s, find(s, 'gy', '白き乙女'), '② 墓地にある状態で', [{ zone: mz(2) }]);
    expect(name(s, s.mz[2]!)).toBe('白き乙女');
  });
});

describe('ブルーアイズのルートガイド', () => {
  const guide = BLUE_GUIDES.find((g) => g.id === 'blue-deep-sage-dragon-master')!;
  const run = (hand: string[], seed = 2) =>
    routeFromGuide(createGame(BLUE_EYES_DECK, ctx, seed, hand), ctx, guide, TOON_EVALUATOR);

  it.each([
    ['ディープアイズ', ['67886895', '14558127', '10045474', '97268402', '23434538']],
    ['賢士（ディープアイズのサーチは不要）', ['8240199', '14558127', '10045474', '97268402', '23434538']],
    ['賢士＋乙女（賢士①のサーチも不要）', ['8240199', '17947697', '10045474', '97268402', '23434538']],
  ])('%s から究極竜魔導師＋精霊龍2体まで', (_, hand) => {
    const route = run(hand)!;
    expect(route).not.toBeNull();
    const s = route.final;
    const field = [...s.mz, ...s.emz].filter((u): u is string => !!u).map((u) => name(s, u));
    expect(field.sort()).toEqual(['究極竜魔導師', '青眼の精霊龍', '青眼の精霊龍'].sort());
    expect(s.stz.some((u) => u && name(s, u) === '真の光' && s.cards[u].faceUp)).toBe(true);
  });

  it('賢士もディープアイズもない手札では使えない', () => {
    expect(run(['17947697', '14558127', '10045474', '97268402', '23434538'])).toBeNull();
  });
});

describe('ブルーアイズのルートガイド（完成形）', () => {
  const guide = BLUE_GUIDES.find((g) => g.id === 'blue-deep-sage-full')!;
  const fieldNames = (s: GameState) =>
    [...s.mz, ...s.emz]
      .filter((u): u is string => !!u)
      .map((u) => name(s, u) + (s.cards[u].destroyAtEnd ? '（EP破壊）' : ''));

  it('ディープアイズ始動：天球の聖刻印・究極竜魔導師・シフルが残る', () => {
    const s = routeFromGuide(
      createGame(BLUE_EYES_DECK, ctx, 2, ['67886895', '14558127', '10045474', '97268402', '23434538']),
      ctx,
      guide,
      TOON_EVALUATOR,
    )!.final;
    expect(fieldNames(s).sort()).toEqual(
      ['天球の聖刻印', '究極竜魔導師', '聖珖神竜 スターダスト・シフル', '青き眼の賢士'].sort(),
    );
    expect(s.hand.map((u) => name(s, u))).toContain('シンクロ・ランブル');
  });

  it('賢士始動（ディープアイズなし）：天球の手は飛ばし、究極霊竜はエンドフェイズに破壊される', () => {
    const s = routeFromGuide(
      createGame(BLUE_EYES_DECK, ctx, 2, ['8240199', '14558127', '10045474', '97268402', '23434538']),
      ctx,
      guide,
      TOON_EVALUATOR,
    )!.final;
    expect(fieldNames(s)).toEqual(
      expect.arrayContaining(['究極竜魔導師', '聖珖神竜 スターダスト・シフル', '青眼の究極霊竜（EP破壊）']),
    );
  });
});
