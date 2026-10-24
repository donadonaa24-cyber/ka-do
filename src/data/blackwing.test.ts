import { describe, expect, it } from 'vitest';
import { afterPick, completeStep, startEffect, stepCandidates, type RunResult } from '../engine/effectRunner';
import { applyAction, createGame, currentLevel, currentStats, getDef, type Action, type Ctx } from '../engine/game';
import type { DeckList, GameState, Location } from '../engine/types';
import { isExtraDeckCard } from '../engine/types';
import { deckProblems } from '../ui/deckStore';
import { ALL_CARDS, BLACKWING_DECK, BUILTIN_DECKS, CARD_DB, CARD_SCRIPTS, EDITABLE_CARDS } from '.';
import { BLACKWING_CARD_DATA } from './blackwingCards.generated';

const ctx: Ctx = { db: CARD_DB, scripts: CARD_SCRIPTS, options: { strict: true } };
const FILLER = ['14558127', '14558127', '23434538', '59438930', '42141493'];
const mz = (index: number) => ({ zone: 'mz' as const, index });
const stz = (index: number) => ({ zone: 'stz' as const, index });
const name = (s: GameState, u: string) => getDef(s, ctx, u).name;
const find = (s: GameState, zone: 'deck' | 'hand' | 'extra' | 'gy' | 'banished', n: string) => {
  const u = s[zone].find((u) => name(s, u) === n);
  if (!u) throw new Error(`${zone}にありません：${n}`);
  return u;
};
const field = (s: GameState, n: string) => [...s.mz, ...s.emz].find((u) => u && name(s, u) === n)!;
const game = () => createGame(BLACKWING_DECK, ctx, 1, FILLER);
const act = (s: GameState, a: Action): GameState => {
  const r = applyAction(s, a, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.state;
};
const move = (s: GameState, u: string, zone: 'hand' | 'gy' | 'banished') =>
  act(s, { type: 'MOVE', uid: u, to: { zone } });
const hand = (s: GameState, n: string) => move(s, find(s, 'deck', n), 'hand');
const put = (s: GameState, n: string, index: number, from: 'deck' | 'extra' | 'hand' = 'deck', as?: 'synchro') =>
  act(s, { type: 'SPECIAL_SUMMON', uid: find(s, from, n), to: mz(index), as });
const proc = (s: GameState, u: string, index: number, materials: string[] = []) =>
  act(s, { type: 'PROC_SUMMON', uid: u, proc: 0, materials, to: mz(index) });
const normal = (s: GameState, n: string, index: number, grant?: number) =>
  act(s, { type: 'NORMAL_SUMMON', uid: find(s, 'hand', n), index, grant });
const synchro = (s: GameState, n: string, materials: string[], index: number) =>
  act(s, {
    type: 'PROCEDURE_SUMMON',
    method: 'synchro',
    uid: find(s, 'extra', n),
    materials,
    to: mz(index),
  });
type Choice = { pick?: string[]; zone?: Location; mode?: number };
function tryEffect(s: GameState, uid: string, label: string, choices: Choice[] = []): GameState | string {
  const effect = CARD_SCRIPTS[s.cards[uid].defId].effects!.find((e) => e.label.includes(label));
  if (!effect) throw new Error(`効果がありません：${label}`);
  let r: RunResult = startEffect(s, ctx, uid, effect);
  for (const c of choices) {
    if (r.kind !== 'running') break;
    if (c.pick) {
      const run = r.run;
      const picked: string[] = [];
      for (const n of c.pick) {
        const u = stepCandidates(run, ctx).find((u) => name(run.temp, u) === n && !picked.includes(u));
        if (!u)
          throw new Error(`候補にありません：${n}（候補：${stepCandidates(run, ctx).map((u) => name(run.temp, u))}）`);
        picked.push(u);
      }
      r = afterPick({ ...run, picked }, ctx);
      if (r.kind === 'running' && c.mode !== undefined) r = afterPick({ ...r.run, mode: c.mode }, ctx);
      if (r.kind === 'running' && r.run.stage === 'zone' && c.zone) r = completeStep(r.run, ctx, c.zone);
    } else if (c.zone) r = completeStep(r.run, ctx, c.zone);
  }
  if (r.kind === 'error') return r.error;
  if (r.kind === 'running') throw new Error(`処理が未完了：${r.run.title} / ${r.run.stepIndex} / ${r.run.stage}`);
  const done = applyAction(s, r.action, ctx);
  return done.ok ? done.state : done.error;
}
function useEffect(...args: Parameters<typeof tryEffect>): GameState {
  const r = tryEffect(...args);
  if (typeof r === 'string') throw new Error(r);
  return r;
}
const withSide = (): DeckList => ({
  ...BLACKWING_DECK,
  main: [...BLACKWING_DECK.main, ...BLACKWING_DECK.side!.filter((id) => !isExtraDeckCard(CARD_DB[id]))],
  extra: [...BLACKWING_DECK.extra, ...BLACKWING_DECK.side!.filter((id) => isExtraDeckCard(CARD_DB[id]))],
});

describe('ブラックフェザー', () => {
  it('デッキ表の各カード名・各枚数と完全に一致する', () => {
    const expected = {
      main: {
        'ＢＦ－疾風のゲイル': 1,
        'ＢＦ－黒槍のブラスト': 1,
        'ＢＦ－精鋭のゼピュロス': 1,
        'ドロール＆ロックバード': 1,
        増殖するＧ: 1,
        'ＢＦ－突風のオロシ': 1,
        幽鬼うさぎ: 1,
        'ＢＦ－砂塵のハルマッタン': 1,
        灰流うらら: 2,
        'ＢＦ－毒風のシムーン': 3,
        'ＢＦ－無頼のヴァータ': 3,
        'ＢＦ－嵐砂のシャマール': 3,
        'ＢＦ－雪撃のチヌーク': 2,
        'ＢＦ－幻耀のスズリ': 3,
        'ＢＦ－下弦のサルンガ': 1,
        'マルチャミー・フワロス': 1,
        ハーピィの羽根帚: 1,
        闇の誘惑: 1,
        黒い旋風: 3,
        'コズミック・サイクロン': 1,
        黒羽の旋風: 3,
        月女神の至天: 1,
        無限泡影: 1,
        'ブラック・バード・クローズ': 1,
        'ＢＦ－ツインシャドウ': 2,
        霊王の波動: 1,
        '聖なる心のバリア －マインドフォース－': 1,
      },
      extra: {
        'ＢＦ－孤高のシルバー・ウィンド': 1,
        'ブラックフェザー・ドラゴン': 2,
        'ＢＦ Ｔ－漆黒のホーク・ジョー': 1,
        'ＢＦ－星影のノートゥング': 1,
        'Ａ ＢＦ－驟雨のライキリ': 1,
        '琰魔竜 レッド・デーモン・アビス': 1,
        'Ａ ＢＦ－五月雨のソハヤ': 1,
        'ＢＦ－フルアーマード・ウィング': 1,
        'ＲＲ－ワイズ・ストリクス': 1,
        'ブラックフェザー・アサルト・ドラゴン': 2,
        'ＢＦ－魔風のボレアース': 2,
        'Ａ ＢＦ－叢雲のクサナギ': 1,
      },
      side: {
        'サンダー・ボルト': 1,
        死者蘇生: 1,
        'ＢＦ－残夜のクリス': 1,
        'ＢＦ－砂塵のハルマッタン': 1,
        'Ａ ＢＦ－涙雨のチドリ': 1,
        'Ａ ＢＦ－神立のオニマル': 1,
        多次元壊獣ラディアン: 1,
        無限泡影: 1,
        'ＢＦ－南風のアウステル': 1,
        天威の龍鬼神: 1,
        'ライトニング・ストーム': 1,
        'ＢＦ－下弦のサルンガ': 1,
        '深淵の神獣ディス・パテル': 1,
        'カオス・アンヘル－混沌の双翼－': 1,
        霆王の閃光: 1,
      },
    };
    for (const zone of ['main', 'extra', 'side'] as const) {
      const actual: Record<string, number> = {};
      for (const id of BLACKWING_DECK[zone]!) actual[CARD_DB[id].name] = (actual[CARD_DB[id].name] ?? 0) + 1;
      expect(actual).toEqual(expected[zone]);
    }
  });

  it('画像どおりメイン42枚（26/10/6）・EX15枚・サイド15枚で、全カードが編集・保存できる', () => {
    expect(BLACKWING_DECK.main).toHaveLength(42);
    expect(BLACKWING_DECK.extra).toHaveLength(15);
    expect(BLACKWING_DECK.side).toHaveLength(15);
    expect(
      ['monster', 'spell', 'trap'].map((kind) => BLACKWING_DECK.main.filter((id) => CARD_DB[id].kind === kind).length),
    ).toEqual([26, 10, 6]);
    expect(deckProblems(BLACKWING_DECK, CARD_DB)).toEqual([]);
    expect(BUILTIN_DECKS).toContain(BLACKWING_DECK);
    for (const id of [...BLACKWING_DECK.main, ...BLACKWING_DECK.extra, ...BLACKWING_DECK.side!]) {
      expect(EDITABLE_CARDS.some((c) => c.id === id)).toBe(true);
      if (BLACKWING_CARD_DATA.some((c) => c.id === id)) expect(CARD_SCRIPTS[id]).toBeDefined();
    }
    for (const c of BLACKWING_CARD_DATA) expect(ALL_CARDS.filter((d) => d.id === c.id)).toHaveLength(1);
  });

  it('データベースの素材条件・ステータスを保持する', () => {
    expect(CARD_DB['10602628']).toMatchObject({
      name: 'ＢＦ－魔風のボレアース',
      level: 6,
      tuner: true,
      atk: 2400,
      def: 1200,
    });
    expect(CARD_DB['33236860'].materialText).toBe('「ＢＦ」チューナー＋チューナー以外のモンスター２体以上');
    expect(CARD_DB['36429703']).toMatchObject({ frame: 'link', link: 2, linkMarkers: ['BL', 'BR'] });
    expect(CARD_DB['40366667'].name).toBe('霊王の波動');
    expect(CARD_DB['53389254'].tuner).toBeUndefined();
    expect(CARD_DB['53389254'].archetypes).toEqual(['BF', 'ABF']);
  });

  it('シムーンから通常召喚権を残して展開し、トークン・ボレアース・ヴァータ・旋風・アサルトまで一連の操作が通る', () => {
    let s = createGame(BLACKWING_DECK, ctx, 1, ['81470373', '14785765', '71187462', '14558127', '42141493']);
    s = useEffect(s, find(s, 'hand', 'ＢＦ－毒風のシムーン'), '①', [
      { pick: ['ＢＦ－精鋭のゼピュロス'] },
      { pick: ['黒い旋風'], zone: stz(0) },
      { pick: ['ＢＦ－毒風のシムーン'], mode: 0, zone: mz(0) },
    ]);
    expect(s.normalSummonUsed).toBe(false);
    expect(s.summonGrants).toEqual([]);
    s = useEffect(s, s.stz[0]!, '①', [{ pick: ['ＢＦ－毒風のシムーン'] }, { pick: ['ＢＦ－幻耀のスズリ'] }]);
    s = normal(s, 'ＢＦ－幻耀のスズリ', 1);
    s = useEffect(s, s.mz[1]!, '①', [{ pick: ['ＢＦ－嵐砂のシャマール'] }]);
    s = useEffect(s, find(s, 'hand', 'ＢＦ－嵐砂のシャマール'), '①', [{ pick: ['黒羽の旋風'], zone: stz(1) }]);
    s = proc(s, find(s, 'hand', 'ＢＦ－無頼のヴァータ'), 2);
    s = useEffect(s, field(s, 'ＢＦ－幻耀のスズリ'), '②', [{ pick: ['ＢＦ－毒風のシムーン'] }, { zone: mz(0) }]);
    const token = s.mz[0]!;
    expect(getDef(s, ctx, token)).toMatchObject({
      tuner: true,
      level: 2,
      atk: 700,
      def: 700,
      race: '鳥獣族',
      attribute: '闇',
    });
    expect(getDef(s, ctx, token).archetypes).toBeUndefined();
    s = synchro(s, 'ＢＦ－魔風のボレアース', [token, s.mz[1]!], 0);
    expect(s.cards[token]).toBeUndefined();
    s = useEffect(s, s.mz[0]!, '①', [{ pick: ['ＢＦ－突風のオロシ'] }]);
    expect(currentLevel(s, ctx, s.mz[0]!)).toBe(1);
    s = useEffect(s, field(s, 'ＢＦ－無頼のヴァータ'), '②', [
      { pick: ['ＢＦ－毒風のシムーン'] },
      { pick: ['ブラックフェザー・ドラゴン'], zone: mz(1) },
    ]);
    const dragon = s.mz[1]!;
    expect(s.cards[dragon].properlySummoned).toBe(false);
    s = useEffect(s, find(s, 'gy', 'ＢＦ－嵐砂のシャマール'), '②', [{ pick: ['ＢＦ－幻耀のスズリ'] }]);
    expect(s.lp).toBe(7300);
    expect(s.cards[dragon].counters).toBe(1);
    expect(currentStats(s, ctx, dragon).atk).toBe(CARD_DB['9012916'].atk! - 700);
    s = useEffect(s, s.stz[1]!, '①', [
      { pick: ['ブラックフェザー・ドラゴン'] },
      { pick: ['ＢＦ－無頼のヴァータ'] },
      { zone: mz(2) },
    ]);
    s = synchro(s, '琰魔竜 レッド・デーモン・アビス', [s.mz[0]!, dragon], 0);
    s = proc(s, find(s, 'extra', 'ブラックフェザー・アサルト・ドラゴン'), 1, [
      find(s, 'gy', 'ＢＦ－魔風のボレアース'),
      dragon,
    ]);
    expect(
      [...s.mz, ...s.emz]
        .filter(Boolean)
        .map((u) => name(s, u!))
        .sort(),
    ).toEqual(
      ['琰魔竜 レッド・デーモン・アビス', 'ブラックフェザー・アサルト・ドラゴン', 'ＢＦ－無頼のヴァータ'].sort(),
    );
    expect(s.cards[s.mz[1]!].properlySummoned).toBe(true);
    s = act(s, { type: 'NEXT_PHASE', to: 'EP' });
    s = useEffect(s, s.stz[0]!, 'エンドフェイズ処理');
    expect(s.stz[0]).toBeNull();
    expect(s.lp).toBe(6300);
  });

  it('シムーンは墓地へ送る方も選べ、既に通常召喚権を使っていても追加の召喚ができる', () => {
    const setup = () => {
      let s = game();
      s = normal(s, '灰流うらら', 0);
      s = move(s, s.mz[0]!, 'gy');
      s = hand(s, 'ＢＦ－毒風のシムーン');
      return hand(s, 'ＢＦ－黒槍のブラスト');
    };
    let s = setup();
    s = useEffect(s, find(s, 'hand', 'ＢＦ－毒風のシムーン'), '①', [
      { pick: ['ＢＦ－黒槍のブラスト'] },
      { pick: ['黒い旋風'], zone: stz(0) },
      { pick: ['ＢＦ－毒風のシムーン'], mode: 1 },
    ]);
    expect(s.gy.map((u) => name(s, u))).toContain('ＢＦ－毒風のシムーン');
    s = setup();
    s = useEffect(s, find(s, 'hand', 'ＢＦ－毒風のシムーン'), '①', [
      { pick: ['ＢＦ－黒槍のブラスト'] },
      { pick: ['黒い旋風'], zone: stz(0) },
      { pick: ['ＢＦ－毒風のシムーン'], mode: 0, zone: mz(0) },
    ]);
    expect(s.normalSummonUsed).toBe(true);
    expect(name(s, s.mz[0]!)).toBe('ＢＦ－毒風のシムーン');
  });

  it('シムーンで置いた旋風を一度手札に戻すと、置き直してもエンドフェイズの処理対象にはならない', () => {
    let s = game();
    s = hand(s, 'ＢＦ－毒風のシムーン');
    s = hand(s, 'ＢＦ－黒槍のブラスト');
    s = useEffect(s, find(s, 'hand', 'ＢＦ－毒風のシムーン'), '①', [
      { pick: ['ＢＦ－黒槍のブラスト'] },
      { pick: ['黒い旋風'], zone: stz(0) },
      { pick: ['ＢＦ－毒風のシムーン'], mode: 1 },
    ]);
    const wind = s.stz[0]!;
    s = move(s, wind, 'hand');
    s = act(s, { type: 'ACTIVATE_CARD', uid: wind });
    s = act(s, { type: 'NEXT_PHASE', to: 'EP' });
    expect(tryEffect(s, wind, 'エンドフェイズ処理')).toBeTypeOf('string');
  });

  it('ヴァータはデッキの非チューナーだけを選び、合計8を要求し、出したドラゴンの蘇生は許可しない', () => {
    let s = put(game(), 'ＢＦ－無頼のヴァータ', 0);
    const vata = s.mz[0]!;
    expect(tryEffect(s, vata, '②', [{ pick: ['ＢＦ－幻耀のスズリ'] }])).toContain('レベル合計を8');
    const effect = CARD_SCRIPTS['71187462'].effects![0];
    const r = startEffect(s, ctx, vata, effect);
    expect(r.kind).toBe('running');
    if (r.kind === 'running')
      expect(stepCandidates(r.run, ctx).map((u) => name(s, u))).not.toContain('ＢＦ－嵐砂のシャマール');
    s = useEffect(s, vata, '②', [
      { pick: ['ＢＦ－毒風のシムーン'] },
      { pick: ['ブラックフェザー・ドラゴン'], zone: mz(1) },
    ]);
    const dragon = s.mz[1]!;
    s = move(s, dragon, 'gy');
    expect(applyAction(s, { type: 'SPECIAL_SUMMON', uid: dragon, to: mz(1) }, ctx)).toMatchObject({ ok: false });
    expect(s.extraLocks).toEqual([{ source: 'ＢＦ－無頼のヴァータ', filter: { attribute: ['闇'] }, all: undefined }]);
  });

  it('スズリは特殊召喚ではサーチできず、トークン効果後はリンク召喚できない', () => {
    let s = put(game(), 'ＢＦ－幻耀のスズリ', 0);
    expect(tryEffect(s, s.mz[0]!, '①')).toBeTypeOf('string');
    s = put(s, 'ＢＦ－黒槍のブラスト', 1);
    s = useEffect(s, s.mz[0]!, '②', [{ pick: ['ＢＦ－黒槍のブラスト'] }, { zone: mz(1) }]);
    expect(s.lp).toBe(7300);
    expect(
      applyAction(
        s,
        {
          type: 'PROCEDURE_SUMMON',
          method: 'link',
          uid: find(s, 'extra', 'ＲＲ－ワイズ・ストリクス'),
          materials: [s.mz[0]!, s.mz[1]!],
          to: { zone: 'emz', index: 0 },
        },
        ctx,
      ),
    ).toMatchObject({ ok: false });
  });

  it('既にリンク召喚して場を離れたモンスターがあっても、スズリのS限定効果は発動できない', () => {
    let s = put(game(), 'ＢＦ－黒槍のブラスト', 0);
    s = put(s, 'ＢＦ－幻耀のスズリ', 1);
    s = act(s, {
      type: 'PROCEDURE_SUMMON',
      method: 'link',
      uid: find(s, 'extra', 'ＲＲ－ワイズ・ストリクス'),
      materials: [s.mz[0]!, s.mz[1]!],
      to: { zone: 'emz', index: 0 },
    });
    s = move(s, s.emz[0]!, 'gy');
    s = put(s, 'ＢＦ－幻耀のスズリ', 0);
    expect(tryEffect(s, s.mz[0]!, '②')).toContain('既にSモンスター以外');
  });

  it('「Ａ ＢＦ」はＢＦをS素材にした時だけフィールドでチューナーになり、無効化・蘇生では解除される', () => {
    let s = put(game(), 'ＢＦ－疾風のゲイル', 0);
    s = put(s, 'ＢＦ－黒槍のブラスト', 1);
    s = synchro(s, 'Ａ ＢＦ－驟雨のライキリ', [s.mz[0]!, s.mz[1]!], 0);
    const raikiri = s.mz[0]!;
    expect(getDef(s, ctx, raikiri).tuner).toBe(true);
    const negated = act(s, { type: 'NEGATE_CARD', uid: raikiri, by: 'テスト' });
    expect(getDef(negated, ctx, raikiri).tuner).not.toBe(true);
    s = move(s, raikiri, 'gy');
    expect(getDef(s, ctx, raikiri).tuner).not.toBe(true);
    s = act(s, { type: 'SPECIAL_SUMMON', uid: raikiri, to: mz(0) });
    expect(getDef(s, ctx, raikiri).tuner).not.toBe(true);
    const otherDeck: DeckList = {
      name: '非ＢＦの素材',
      main: ['14558127', '23434538', '23893227', '94145021', '42141493'],
      extra: ['16051717'],
    };
    s = createGame(otherDeck, ctx, 1);
    s = put(s, '灰流うらら', 0, 'hand');
    s = put(s, '増殖するＧ', 1, 'hand');
    s = put(s, 'サイバー・ドラゴン・コア', 2, 'hand');
    s = synchro(s, 'Ａ ＢＦ－驟雨のライキリ', [s.mz[0]!, s.mz[1]!, s.mz[2]!], 0);
    expect(getDef(s, ctx, s.mz[0]!).tuner).not.toBe(true);
  });

  it('特殊召喚条件は別名ＢＦ・1ターンに1度・サルンガの現在攻撃力を確認する', () => {
    let s = hand(game(), 'ＢＦ－無頼のヴァータ');
    const vata = find(s, 'hand', 'ＢＦ－無頼のヴァータ');
    expect(applyAction(s, { type: 'PROC_SUMMON', uid: vata, proc: 0, materials: [], to: mz(0) }, ctx).ok).toBe(false);
    s = put(s, 'ＢＦ－黒槍のブラスト', 0);
    s = proc(s, vata, 1);
    s = move(s, vata, 'hand');
    expect(applyAction(s, { type: 'PROC_SUMMON', uid: vata, proc: 0, materials: [], to: mz(1) }, ctx).ok).toBe(false);
    s = hand(s, 'ＢＦ－下弦のサルンガ');
    const sarunga = find(s, 'hand', 'ＢＦ－下弦のサルンガ');
    expect(applyAction(s, { type: 'PROC_SUMMON', uid: sarunga, proc: 0, materials: [], to: mz(2) }, ctx).ok).toBe(
      false,
    );
    s = act(s, { type: 'STAT_MOD', uid: s.mz[0]!, atk: 300 });
    s = proc(s, sarunga, 2);
    expect(s.mz[2]).toBe(sarunga);
  });

  it('ハルマッタンは対象の現在レベル分だけレベルが上がり、場を離れると戻る', () => {
    let s = put(game(), 'ＢＦ－黒槍のブラスト', 0);
    s = act(s, { type: 'LEVEL_MOD', uid: s.mz[0]!, delta: 1 });
    s = hand(s, 'ＢＦ－砂塵のハルマッタン');
    s = proc(s, find(s, 'hand', 'ＢＦ－砂塵のハルマッタン'), 1);
    const harmattan = s.mz[1]!;
    s = useEffect(s, harmattan, '②', [{ pick: ['ＢＦ－黒槍のブラスト'] }]);
    expect(currentLevel(s, ctx, harmattan)).toBe(7);
    s = move(s, harmattan, 'hand');
    expect(currentLevel(s, ctx, harmattan)).toBe(2);
  });

  it('ゼピュロスは400ダメージを受け、ターンをまたいでもデュエル中1度の制限が残る', () => {
    let s = game();
    s = move(s, find(s, 'deck', 'ＢＦ－精鋭のゼピュロス'), 'gy');
    s = put(s, 'ＢＦ－黒槍のブラスト', 0);
    const zephyros = find(s, 'gy', 'ＢＦ－精鋭のゼピュロス');
    s = useEffect(s, zephyros, '①', [{ pick: ['ＢＦ－黒槍のブラスト'] }, { zone: mz(0) }]);
    expect(s.lp).toBe(7600);
    s = move(s, zephyros, 'gy');
    while (s.hand.length > 6) s = move(s, s.hand[0], 'gy');
    s = act(s, { type: 'END_TURN', toOpponent: true });
    s = act(s, { type: 'END_TURN' });
    s = act(s, { type: 'NEXT_PHASE', to: 'M1' });
    s = put(s, 'ＢＦ－幻耀のスズリ', 0);
    expect(tryEffect(s, zephyros, '①')).toContain('1');
  });

  it('黒い旋風は特殊召喚には反応せず、召喚したＢＦより攻撃力が低いカードだけを選ぶ', () => {
    let s = hand(game(), '黒い旋風');
    s = act(s, { type: 'ACTIVATE_CARD', uid: find(s, 'hand', '黒い旋風') });
    const wind = s.stz[0]!;
    s = put(s, 'ＢＦ－黒槍のブラスト', 0);
    expect(tryEffect(s, wind, '①')).toBeTypeOf('string');
    s = hand(s, 'ＢＦ－幻耀のスズリ');
    s = normal(s, 'ＢＦ－幻耀のスズリ', 1);
    let r = startEffect(s, ctx, wind, CARD_SCRIPTS['91351370'].effects![1]);
    if (r.kind !== 'running') throw new Error('召喚されたＢＦを選べません');
    r = afterPick({ ...r.run, picked: [s.mz[1]!] }, ctx);
    if (r.kind !== 'running') throw new Error('サーチできません');
    expect(stepCandidates(r.run, ctx).map((u) => name(r.run.temp, u))).toContain('ＢＦ－無頼のヴァータ');
    expect(stepCandidates(r.run, ctx).map((u) => name(r.run.temp, u))).not.toContain('ＢＦ－幻耀のスズリ');
  });

  it('黒羽の旋風はそのカードを置く前の特殊召喚には反応せず、不正規のEXとアウステルを蘇生候補にしない', () => {
    let s = createGame(withSide(), ctx, 1, FILLER);
    s = put(s, 'ブラックフェザー・ドラゴン', 0, 'extra');
    s = hand(s, '黒羽の旋風');
    s = act(s, { type: 'ACTIVATE_CARD', uid: find(s, 'hand', '黒羽の旋風') });
    expect(tryEffect(s, s.stz[0]!, '①')).toBeTypeOf('string');
    s = move(s, s.mz[0]!, 'gy');
    s = move(s, find(s, 'deck', 'ＢＦ－南風のアウステル'), 'gy');
    s = move(s, find(s, 'deck', 'ＢＦ－無頼のヴァータ'), 'gy');
    s = put(s, 'ブラックフェザー・ドラゴン', 0, 'extra');
    let r = startEffect(s, ctx, s.stz[0]!, CARD_SCRIPTS['7602800'].effects![1]);
    if (r.kind !== 'running') throw new Error('召喚元を選べません');
    r = afterPick({ ...r.run, picked: [s.mz[0]!] }, ctx);
    if (r.kind !== 'running') throw new Error('対象を選べません');
    const names = stepCandidates(r.run, ctx).map((u) => name(r.run.temp, u));
    expect(names).toContain('ＢＦ－無頼のヴァータ');
    expect(names).not.toContain('ＢＦ－南風のアウステル');
    expect(names).not.toContain('ブラックフェザー・ドラゴン');
  });

  it('ツインシャドウは手札発動にＢＦ2体を要求し、2体のコストを戻してS召喚扱いで出す', () => {
    let s = hand(game(), 'ＢＦ－ツインシャドウ');
    const twin = find(s, 'hand', 'ＢＦ－ツインシャドウ');
    expect(tryEffect(s, twin, '①')).toContain('2体以上');
    s = put(s, 'ＢＦ－黒槍のブラスト', 0);
    s = put(s, 'ＢＦ－疾風のゲイル', 1);
    s = move(s, find(s, 'deck', 'ＢＦ－嵐砂のシャマール'), 'gy');
    s = move(s, find(s, 'deck', 'ＢＦ－幻耀のスズリ'), 'banished');
    s = useEffect(s, twin, '①', [
      { pick: ['ＢＦ－嵐砂のシャマール', 'ＢＦ－幻耀のスズリ'] },
      { pick: ['ＢＦ－孤高のシルバー・ウィンド'], zone: mz(2) },
    ]);
    expect(s.cards[s.mz[2]!]).toMatchObject({ summonType: 'synchro', properlySummoned: true });
    expect(s.deck.some((u) => name(s, u) === 'ＢＦ－嵐砂のシャマール')).toBe(true);
    expect(s.gy).toContain(twin);
    s = hand(s, 'ＢＦ－ツインシャドウ');
    expect(tryEffect(s, find(s, 'hand', 'ＢＦ－ツインシャドウ'), '①')).toBeTypeOf('string');
  });

  it('アウステルは特殊召喚できず、召喚時に除外ＢＦを守備表示で戻す', () => {
    let s = createGame(withSide(), ctx, 1, FILLER);
    s = hand(s, 'ＢＦ－南風のアウステル');
    const auster = find(s, 'hand', 'ＢＦ－南風のアウステル');
    expect(applyAction(s, { type: 'SPECIAL_SUMMON', uid: auster, to: mz(0) }, ctx).ok).toBe(false);
    s = move(s, find(s, 'deck', 'ＢＦ－幻耀のスズリ'), 'banished');
    s = normal(s, 'ＢＦ－南風のアウステル', 0);
    s = useEffect(s, auster, '①', [{ pick: ['ＢＦ－幻耀のスズリ'] }, { zone: mz(1) }]);
    expect(s.cards[s.mz[1]!].position).toBe('def');
  });

  it('ノートゥングの追加召喚権は有効な本人がいる間だけ使え、1ターン1回に限る', () => {
    let s = put(game(), 'ＢＦ－星影のノートゥング', 0, 'extra', 'synchro');
    const nothung = s.mz[0]!;
    s = normal(s, '灰流うらら', 1);
    s = useEffect(s, nothung, '②');
    s = hand(s, 'ＢＦ－幻耀のスズリ');
    const suzuri = find(s, 'hand', 'ＢＦ－幻耀のスズリ');
    const gone = move(s, nothung, 'gy');
    expect(applyAction(gone, { type: 'NORMAL_SUMMON', uid: suzuri, index: 0, grant: 0 }, ctx).ok).toBe(false);
    s = normal(s, 'ＢＦ－幻耀のスズリ', 2, 0);
    expect(s.summonGrants).toEqual([]);
    expect(tryEffect(s, nothung, '②')).toBeTypeOf('string');
  });

  it('シルバー・ウィンドは通常のS召喚では非チューナー2体以上を要求する', () => {
    let s = put(game(), 'ＢＦ－嵐砂のシャマール', 0);
    s = put(s, 'ＢＦ－黒槍のブラスト', 1);
    expect(
      applyAction(
        s,
        {
          type: 'PROCEDURE_SUMMON',
          method: 'synchro',
          uid: find(s, 'extra', 'ＢＦ－孤高のシルバー・ウィンド'),
          materials: [s.mz[0]!, s.mz[1]!],
          to: mz(0),
        },
        ctx,
      ).ok,
    ).toBe(false);
    s = move(s, s.mz[1]!, 'gy');
    s = put(s, 'ＢＦ－雪撃のチヌーク', 1);
    s = put(s, 'ＢＦ－砂塵のハルマッタン', 2);
    s = synchro(s, 'ＢＦ－孤高のシルバー・ウィンド', [s.mz[0]!, s.mz[1]!, s.mz[2]!], 0);
    expect(name(s, s.mz[0]!)).toBe('ＢＦ－孤高のシルバー・ウィンド');
  });

  it('アサルトは通常の非Sチューナーを素材にできず、効果での蘇生もできない', () => {
    let s = put(game(), 'ＢＦ－無頼のヴァータ', 0);
    s = put(s, 'ブラックフェザー・ドラゴン', 1, 'extra', 'synchro');
    const assault = find(s, 'extra', 'ブラックフェザー・アサルト・ドラゴン');
    expect(
      applyAction(
        s,
        { type: 'PROCEDURE_SUMMON', method: 'synchro', uid: assault, materials: [s.mz[0]!, s.mz[1]!], to: mz(0) },
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      applyAction(s, { type: 'PROC_SUMMON', uid: assault, proc: 0, materials: [s.mz[0]!, s.mz[1]!], to: mz(0) }, ctx)
        .ok,
    ).toBe(false);
    expect(applyAction(s, { type: 'SPECIAL_SUMMON', uid: assault, to: mz(2) }, ctx).ok).toBe(false);
  });

  it('カオス・アンヘルは光・闇の非チューナーを代用してS召喚できる', () => {
    let s = createGame(withSide(), ctx, 1, FILLER);
    s = put(s, 'ＢＦ－毒風のシムーン', 0);
    s = put(s, 'ＢＦ－黒槍のブラスト', 1);
    s = proc(s, find(s, 'extra', 'カオス・アンヘル－混沌の双翼－'), 0, [s.mz[0]!, s.mz[1]!]);
    expect(s.cards[s.mz[0]!]).toMatchObject({ summonType: 'synchro', properlySummoned: true });
  });

  it('闇の誘惑はドロー後の闇属性を除外し、闇属性がいなければ手札を全て墓地へ送る', () => {
    let s = hand(game(), '闇の誘惑');
    s = hand(s, 'ＢＦ－毒風のシムーン');
    const spell = find(s, 'hand', '闇の誘惑');
    s = useEffect(s, spell, '発動', [{ pick: ['ＢＦ－毒風のシムーン'] }]);
    expect(s.banished.map((u) => name(s, u))).toContain('ＢＦ－毒風のシムーン');
    expect(s.gy).toContain(spell);
    const noDark: DeckList = {
      name: '闇属性なし',
      main: ['1475311', '14558127', '14558127', '14558127', '59438930', '59438930', '59438930'],
      extra: [],
    };
    s = createGame(noDark, ctx, 1, ['1475311', '14558127', '14558127', '14558127', '59438930']);
    s = useEffect(s, find(s, 'hand', '闇の誘惑'), '発動', [{ pick: [] }]);
    expect(s.hand).toEqual([]);
    expect(s.gy).toHaveLength(7);
  });

  it('追加したＢＦの効果操作を最初から再生しても同じ盤面になる', () => {
    const initial = game();
    const vata = find(initial, 'deck', 'ＢＦ－無頼のヴァータ');
    const actions: Action[] = [
      { type: 'MOVE', uid: vata, to: { zone: 'hand' } },
      { type: 'SPECIAL_SUMMON', uid: find(initial, 'deck', 'ＢＦ－黒槍のブラスト'), to: mz(0) },
      { type: 'PROC_SUMMON', uid: vata, proc: 0, materials: [], to: mz(1) },
    ];
    const first = actions.reduce(act, initial);
    expect(actions.reduce(act, game())).toEqual(first);
  });

  it('ラディアンは相手の壊獣が必要で、必ず攻撃表示で自分フィールドへ出る', () => {
    let s = createGame(withSide(), ctx, 1, FILLER);
    s = hand(s, '多次元壊獣ラディアン');
    const radian = find(s, 'hand', '多次元壊獣ラディアン');
    expect(tryEffect(s, radian, '②')).toContain('相手フィールドに');
    s = act(s, { type: 'OPP_PLACE', defId: '28674152', to: { zone: 'omz', index: 0 }, faceUp: true });
    s = useEffect(s, radian, '②', [{ zone: mz(0) }]);
    expect(s.cards[radian].position).toBe('atk');
    expect(s.mz[0]).toBe(radian);
  });
});
