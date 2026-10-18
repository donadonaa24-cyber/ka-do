import { describe, expect, it } from 'vitest';
import {
  afterPick,
  chainableEffects,
  completeStep,
  fizzleTop,
  type RunResult,
  type Running,
  startEffect,
  startResolve,
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
import { enumerateActions, preferredStz } from '../engine/solver';
import { BLUE_EYES_DECK, CARD_DB, CARD_SCRIPTS } from '.';
import { BLUE_GUIDES } from './blueGuides';
import { OPP_PRESETS, oppPresetAction } from './oppPresets';
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
  it('デッキはメイン42枚・EX15枚で登録できる', () => {
    expect(BLUE_EYES_DECK.main).toHaveLength(42);
    expect(BLUE_EYES_DECK.extra).toHaveLength(15);
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
    // 儀式召喚でしか出せないので、デッキから特殊召喚する候補に出ない
    const r = (() => {
      try {
        return tryEffect(a, find(a, 'hand', '青き眼の賢士'), '② 手札から捨て', [
          { pick: ['白き乙女'] },
          { pick: ['ブルーアイズ・カオス・ＭＡＸ・ドラゴン'], zone: mz(1) },
        ]);
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(r).toMatch(/候補にありません: ブルーアイズ・カオス・ＭＡＸ・ドラゴン/);

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
    // シフルはS召喚でしか出せないので候補に出ない
    expect(() =>
      tryEffect(s, spirit, '③ S召喚したこのカード', [{ pick: ['聖珖神竜 スターダスト・シフル'], zone: mz(1) }]),
    ).toThrow(/候補にありません: 聖珖神竜 スターダスト・シフル/);
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
      { pick: ['青眼の究極竜'], zone: { zone: 'stz', index: 2 } },
    ]);
    const equip = s.stz[2]!;
    expect(name(s, equip)).toBe('青眼の究極竜');
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
      ['天球の聖刻印', '究極竜魔導師', '聖珖神竜 スターダスト・シフル', '青眼の究極霊竜（EP破壊）'].sort(),
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

describe('相手ターン（妨害の練習）', () => {
  it('エンドフェイズに究極霊竜が破壊され③で蘇生、相手ターンに天球①→②で白き幻獣を守備表示で特殊召喚', () => {
    const guide = BLUE_GUIDES.find((g) => g.id === 'blue-deep-sage-full')!;
    let s = routeFromGuide(
      createGame(BLUE_EYES_DECK, ctx, 2, ['67886895', '14558127', '10045474', '97268402', '23434538']),
      ctx,
      guide,
      TOON_EVALUATOR,
    )!.final;
    s = act(s, { type: 'END_TURN', toOpponent: true });
    expect(s.opponentTurn).toBe(true);
    const ultimate = find(s, 'gy', '青眼の究極霊竜');
    expect(s.cards[ultimate].movedReason).toBe('効果で破壊');
    // 自分のターンの起動効果・通常召喚は使えない
    expect(applyAction(s, { type: 'NORMAL_SUMMON', uid: s.hand[0], index: 0 }, ctx)).toMatchObject({ ok: false });
    // 究極霊竜③（誘発効果）は使える
    const free = s.mz.indexOf(null);
    s = useEffect(s, ultimate, '③ 戦闘・効果で破壊された時', [{ pick: ['青眼の精霊龍'], zone: mz(free) }]);
    // 天球①：天球自身をリリース → ②でデッキから白き幻獣を守備表示で
    const sphere = s.emz.find((u) => u && name(s, u) === '天球の聖刻印')!;
    s = useEffect(s, sphere, '① 相手ターン', [{ pick: ['天球の聖刻印'] }, { pick: [] }]);
    const z = s.mz.indexOf(null);
    s = useEffect(s, sphere, '② リリースされた時', [{ pick: ['白き幻獣－青眼の白龍'], mode: 0, zone: mz(z) }]);
    const beast = s.mz[z]!;
    expect(name(s, beast)).toBe('白き幻獣－青眼の白龍');
    expect(s.cards[beast].position).toBe('def');
    // 白き幻獣②（相手モンスター全破壊）は相手モンスターがいないと使えない
    expect(tryEffect(s, beast, '② 手札・デッキから特殊召喚した時')).toMatch(/相手フィールドにモンスターがいません/);
    // 練習用に相手モンスターを置くと、破壊して相手の墓地へ送れる
    s = act(s, { type: 'OPP_PLACE', defId: '89631139', to: { zone: 'omz', index: 2 }, faceUp: true });
    s = useEffect(s, beast, '② 手札・デッキから特殊召喚した時');
    expect(s.opp!.mz.every((u) => !u)).toBe(true);
    expect(s.opp!.gy.length).toBe(1);
    // 自分のターンに戻るとドローする
    const hand = s.hand.length;
    s = act(s, { type: 'END_TURN' });
    expect(s.opponentTurn).toBe(false);
    expect(s.hand.length).toBe(hand + 1);
  });

  it('天球①は自分のターンには使えない', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, []);
    s = act(s, { type: 'SPECIAL_SUMMON', uid: find(s, 'extra', '天球の聖刻印'), to: { zone: 'emz', index: 0 } });
    expect(tryEffect(s, s.emz[0]!, '① 相手ターン', [])).toMatch(/相手ターンにのみ/);
  });
});

describe('魔法・罠を置く場所', () => {
  it('白き乙女①の真の光は置く場所を選べる', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['17947697']);
    s = useEffect(s, find(s, 'hand', '白き乙女'), '① 手札・フィールドから墓地へ', [
      { pick: ['真の光'], zone: { zone: 'stz', index: 3 } },
    ]);
    expect(name(s, s.stz[3]!)).toBe('真の光');
  });

  it('ルート探索は自分のモンスターと同じ縦列を避けて置く', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['17947697']);
    s = put(s, find(s, 'deck', '青眼の白龍'), 0);
    s = put(s, find(s, 'deck', '青眼の白龍'), 1);
    expect(preferredStz(s).slice(0, 3)).toEqual([2, 3, 4]);
    const placed = enumerateActions(s, ctx)
      .map((a) => applyAction(s, a, ctx))
      .filter((r) => r.ok && r.state.stz.some((u) => u && name(r.state, u) === '真の光'));
    expect(placed.length).toBeGreaterThan(0);
    for (const r of placed) if (r.ok) expect(r.state.stz.findIndex((u) => u && name(r.state, u) === '真の光')).toBe(2);
  });
});

describe('神を超えたしもべ－青眼の究極竜', () => {
  it('究極融合で青眼の白龍3体から融合召喚でき、3回攻撃できる', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['71143015', '89631139']);
    s = put(s, find(s, 'deck', '青眼の白龍'), 0);
    s = act(s, { type: 'MOVE', uid: find(s, 'deck', '青眼の白龍'), to: { zone: 'gy' } });
    s = useEffect(s, find(s, 'hand', '究極融合'), '発動', [
      { pick: ['神を超えたしもべ－青眼の究極竜'] },
      { pick: ['青眼の白龍', '青眼の白龍', '青眼の白龍'], zone: mz(1) },
    ]);
    const servant = s.mz[1]!;
    expect(name(s, servant)).toBe('神を超えたしもべ－青眼の究極竜');
    // 3回攻撃（次の自分のターンのバトルフェイズで確認）
    s = act(s, { type: 'END_TURN' });
    s = act(s, { type: 'NEXT_PHASE', to: 'BP' });
    s = { ...s, opponentLp: 100000 }; // 2回の攻撃で勝ってしまうので、相手のLPを増やして回数だけ確かめる
    for (let i = 0; i < 3; i++) s = act(s, { type: 'ATTACK', uid: servant });
    expect(applyAction(s, { type: 'ATTACK', uid: servant }, ctx)).toMatchObject({ ok: false });
  });
});

describe('ブルーアイズのサイドデッキ', () => {
  it('サイド15枚を含めて構築ルールを満たす', () => {
    expect(BLUE_EYES_DECK.side).toHaveLength(15);
    expect(deckProblems(BLUE_EYES_DECK, CARD_DB)).toEqual([]);
    // サイドも含めて同名カードは3枚まで
    const bad = { ...BLUE_EYES_DECK, side: [...BLUE_EYES_DECK.side!, '89631139'] };
    expect(deckProblems(bad, CARD_DB).join()).toContain('3枚まで');
  });

  // サイドのカードを入れたデッキ（メインの一部と入れ替え）
  const sided = (ids: string[]) => ({ ...BLUE_EYES_DECK, main: [...ids, ...BLUE_EYES_DECK.main.slice(ids.length)] });

  it('ドラゴン・目覚めの旋律：攻撃力3000以上・守備力2500以下のドラゴン族を2体まで', () => {
    let s = createGame(sided(['48800175']), ctx, 1, ['48800175', '14558127']);
    s = useEffect(s, find(s, 'hand', 'ドラゴン・目覚めの旋律'), '発動', [
      { pick: ['灰流うらら'] },
      { pick: ['青眼の白龍', '白き幻獣－青眼の白龍'] },
    ]);
    expect(s.hand.map((u) => name(s, u))).toEqual(expect.arrayContaining(['青眼の白龍', '白き幻獣－青眼の白龍']));
  });

  it('ビンゴマシーンGO!GO!：3枚から相手がランダムに選んだ1枚を手札に加える', () => {
    let s = createGame(sided(['93437091']), ctx, 1, ['93437091']);
    const before = s.hand.length;
    s = useEffect(s, find(s, 'hand', 'ビンゴマシーンＧＯ！ＧＯ！'), '発動', [
      { pick: ['青眼の白龍', '青き眼の祈り', '真の光'] },
    ]);
    expect(s.hand.length).toBe(before); // ビンゴを使って1枚加えた
    expect(['青眼の白龍', '青き眼の祈り', '真の光']).toContain(name(s, s.hand[s.hand.length - 1]));
  });

  it('青眼の双爆裂龍：場の青眼の白龍2体を墓地へ送って特殊召喚', () => {
    // サイドのカードはゲームに入らないので、EXに入れたデッキで確かめる
    const g = createGame({ ...BLUE_EYES_DECK, extra: ['2129638'] }, ctx, 1, []);
    let t = put(g, find(g, 'deck', '青眼の白龍'), 0);
    t = put(t, find(t, 'deck', '青眼の白龍'), 1);
    const twin = find(t, 'extra', '青眼の双爆裂龍');
    t = act(t, { type: 'PROC_SUMMON', uid: twin, proc: 0, materials: [t.mz[0]!, t.mz[1]!], to: mz(0) });
    expect(name(t, t.mz[0]!)).toBe('青眼の双爆裂龍');
    expect(t.gy.filter((u) => name(t, u) === '青眼の白龍')).toHaveLength(2);
  });
});

describe('究極融合（バグ報告）', () => {
  const fusion = (s: GameState) => s.hand.find((u) => name(s, u) === '究極融合')!;
  const effect = CARD_SCRIPTS['71143015'].effects![0];

  it('融合できない究極融合が手札にあっても、賢士①はチェーン確認で止まらずに処理できる', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['8240199', '71143015']);
    const sage = find(s, 'hand', '青き眼の賢士');
    s = act(s, { type: 'NORMAL_SUMMON', uid: sage, index: 0 });
    const effect = CARD_SCRIPTS[s.cards[sage].defId].effects!.find((e) => e.label.includes('① 召喚時'))!;
    const r = startEffect(s, ctx, sage, effect, undefined, 'auto');
    expect(r.kind).toBe('running');
    expect(chainableEffects(s, ctx, 2).map((c) => name(s, c.uid))).not.toContain('究極融合');
  });

  it('セットしたターンの速攻魔法はチェーンできない', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['71143015']);
    s = put(s, find(s, 'deck', '青眼の白龍'), 0);
    s = put(s, find(s, 'deck', '青眼の白龍'), 1);
    s = act(s, { type: 'SET_SPELL_TRAP', uid: fusion(s), index: 0 });
    expect(chainableEffects(s, ctx, 1).map((c) => name(s, c.uid))).not.toContain('究極融合');
  });

  it('融合できる組み合わせが無ければ発動できない（空打ちしない）', () => {
    const s = createGame(BLUE_EYES_DECK, ctx, 1, ['71143015', '14558127']);
    expect(tryEffect(s, fusion(s), '発動')).toMatch(/融合召喚できる/);
  });

  it('青眼の白龍2体がいれば発動でき、チェーンの解決中に素材がいなくなれば不発になる', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['71143015']);
    s = put(s, find(s, 'deck', '青眼の白龍'), 0);
    s = put(s, find(s, 'deck', '青眼の白龍'), 1);
    const card = fusion(s);
    const r = startEffect(s, ctx, card, effect, undefined, 'force');
    expect(r.kind).toBe('done');
    if (r.kind !== 'done') return;
    s = act(s, r.action);
    expect(s.chain.length).toBe(1);
    // 不発にする：チェーンが消え、究極融合は墓地へ
    const fizzled = act(s, fizzleTop(s, ctx)!);
    expect(fizzled.chain.length).toBe(0);
    expect(fizzled.gy).toContain(card);
    // 素材が無くなってから解決すると、選べるカードが無いので不発
    for (const u of [s.mz[0]!, s.mz[1]!]) s = act(s, { type: 'MOVE', uid: u, to: { zone: 'banished' } });
    const done = startResolve(s, ctx);
    expect(done.kind).toBe('done');
    if (done.kind !== 'done') return;
    s = act(s, done.action);
    expect(s.chain.length).toBe(0);
    expect(s.gy).toContain(card);
    expect(s.log.some((l) => l.text.includes('不発'))).toBe(true);
  });
});

describe('相手の妨害（トゥーンの最終盤面）', () => {
  const resolveAll = (s: GameState) => {
    while (s.chain.length) {
      const r = startResolve(s, ctx);
      if (r.kind !== 'done') throw new Error(`解決できません: ${r.kind === 'error' ? r.error : r.kind}`);
      s = act(s, r.action);
    }
    return s;
  };

  it('4妨害：テラー→バロネス→ゲオルギアス③→ア＝バオの順にチェーンして止めてくる', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['17947697', '8240199']);
    s = act(s, oppPresetAction(s, OPP_PRESETS[3]));
    expect(s.opp!.mz.filter(Boolean)).toHaveLength(4);
    // 1回目：白き乙女①（モンスター効果）→ トゥーン・テラーで無効
    const maiden = find(s, 'hand', '白き乙女');
    const e1 = CARD_SCRIPTS[s.cards[maiden].defId].effects!.find((e) => e.label.startsWith('①'))!;
    let r = startEffect(s, ctx, maiden, e1, undefined, 'auto');
    if (r.kind === 'running') r = completeStep(r.run, ctx, null);
    expect(r.kind).toBe('done');
    s = act(s, (r as { action: Action }).action);
    expect(s.chain.map((l) => l.opp ?? '自分')).toEqual(['自分', 'terror']);
    s = resolveAll(s);
    expect(s.stz.every((u) => !u)).toBe(true);
    expect(s.log.some((l) => l.text.includes('無効になり破壊'))).toBe(true);
    // 2回目：賢士を召喚して①→ バロネスで無効
    const sage = find(s, 'hand', '青き眼の賢士');
    s = act(s, { type: 'NORMAL_SUMMON', uid: sage, index: 0 });
    const e2 = CARD_SCRIPTS[s.cards[sage].defId].effects!.find((e) => e.label.includes('① 召喚時'))!;
    r = startEffect(s, ctx, sage, e2, undefined, 'auto');
    expect(r.kind).toBe('done');
    s = act(s, (r as { action: Action }).action);
    expect(s.chain[1].opp).toBe('baroness');
    s = resolveAll(s);
    // 無効にして破壊：賢士は墓地へ
    expect(s.gy).toContain(sage);
  });

  it('魔法の発動にはゲオルギアス③、モンスターがいればア＝バオで破壊してくる', () => {
    let s = createGame(BLUE_EYES_DECK, ctx, 1, ['8240199', '80326401', '89631139']);
    s = act(s, oppPresetAction(s, OPP_PRESETS[3]));
    // テラー・バロネスを先に使わせる
    s = act(s, { type: 'OPP_USE', uid: s.opp!.stz[2]!, key: 'opp:トゥーン・テラー' });
    s = act(s, { type: 'OPP_USE', uid: s.opp!.mz[1]!, key: 'baroness2', once: true });
    const spell = s.hand.find((u) => CARD_DB[s.cards[u].defId].kind === 'spell')!;
    const eff = CARD_SCRIPTS[s.cards[spell].defId].effects!.find((e) => e.isCardActivation)!;
    let r = startEffect(s, ctx, spell, eff, { zone: 'stz', index: 0 }, 'auto');
    while (r.kind === 'running') {
      const run: Running = r.run;
      const pick = stepCandidates(run, ctx).filter((u) => name(run.temp, u) !== '青き眼の賢士');
      r = afterPick({ ...run, picked: pick.slice(0, 1) }, ctx);
    }
    expect(r.kind).toBe('done');
    s = act(s, (r as { action: Action }).action);
    expect(s.chain[1]?.opp).toBe('georgias');
    s = resolveAll(s);
    expect(s.gy).toContain(spell);
    // 賢士を召喚して①→ ア＝バオ・ア・クゥーで賢士を破壊（効果は処理される）
    const sage = find(s, 'hand', '青き眼の賢士');
    s = act(s, { type: 'NORMAL_SUMMON', uid: sage, index: 0 });
    const e2 = CARD_SCRIPTS[s.cards[sage].defId].effects!.find((e) => e.label.includes('① 召喚時'))!;
    r = startEffect(s, ctx, sage, e2, undefined, 'auto');
    s = act(s, (r as { action: Action }).action);
    expect(s.chain[1].opp).toBe('abao');
    const top = startResolve(s, ctx);
    s = act(s, (top as { action: Action }).action);
    expect(s.gy).toContain(sage);
  });
});
