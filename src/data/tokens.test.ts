import { describe, expect, it } from 'vitest';
import { afterPick, completeStep, startEffect, startResolve, type RunResult } from '../engine/effectRunner';
import { applyAction, createGame, getDef, type Action, type Ctx } from '../engine/game';
import { enumerateActions } from '../engine/solver';
import type { CardDef, GameState, Location } from '../engine/types';
import { BLACKWING_DECK, CARD_DB, CARD_SCRIPTS, TG_DECK } from '.';

// 以下は mycard/ygopro-database（217ae165c1886af2fc36b823fc08f9fc3ec13185）
// locales/ja-JP/cards.cdb から取得した壊獣カウンターのテスト用データ。既製デッキには追加しない。
const HOLDER_CARDS: CardDef[] = [
  {
    id: '11163040',
    name: '壊獣の出現記録',
    kind: 'spell',
    spellType: 'continuous',
    text: '①：手札・墓地から「壊獣」モンスターが特殊召喚される度にこのカードに壊獣カウンターを１つ置く（最大５つまで）。\n②：１ターンに１度、フィールドの「壊獣」モンスター１体を対象として発動できる。\nそのモンスターを破壊し、その後、そのコントローラーのフィールドに、破壊したそのモンスターとは元々のカード名が異なる「壊獣」モンスター１体を自分のデッキから特殊召喚する。\n③：壊獣カウンターが３つ以上のこのカードを墓地へ送って発動できる。\nデッキから「壊獣の出現記録」以外の「壊獣」魔法・罠カード１枚を手札に加える。',
  },
  {
    id: '56111151',
    name: 'ＫＹＯＵＴＯＵウォーターフロント',
    kind: 'spell',
    spellType: 'field',
    text: '①：フィールドのカードが墓地へ送られる度に、１枚につき１つこのカードに壊獣カウンターを置く（最大５つまで）。\n②：１ターンに１度、このカードの壊獣カウンターが３つ以上の場合に発動できる。\n自分はデッキから「壊獣」モンスター１体を手札に加える。\n③：このカードが効果で破壊される場合、代わりにこのカードの壊獣カウンターを１つ取り除く事ができる。',
  },
  {
    id: '81057455',
    name: '壊獣捕獲大作戦',
    kind: 'trap',
    trapType: 'continuous',
    text: 'このカード名の②の効果は１ターンに１度しか使用できない。\n①：１ターンに１度、フィールドの「壊獣」モンスター１体を対象として発動できる。\nそのモンスターを裏側守備表示にする。\nその後、このカードに壊獣カウンターを１つ置く（最大３つまで）。\n②：このカードが相手の効果で破壊され墓地へ送られた場合に発動できる。\n自分は２枚ドローする。',
  },
];
const ctx: Ctx = {
  db: { ...CARD_DB, ...Object.fromEntries(HOLDER_CARDS.map((d) => [d.id, d])) },
  scripts: CARD_SCRIPTS,
  options: { strict: true },
};
const mz = (index: number) => ({ zone: 'mz' as const, index });
const act = (s: GameState, action: Action): GameState => {
  const r = applyAction(s, action, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.state;
};
const uid = (s: GameState, id: string) => Object.values(s.cards).find((c) => c.defId === id)!.uid;
const token = (s: GameState) => [...s.mz, ...s.emz].find((u) => u && getDef(s, ctx, u).frame === 'token')!;
type Choice = { pick?: string[]; zone?: Location };
function effect(
  s: GameState,
  source: string,
  label: string,
  choices: Choice[],
  chainMode: 'never' | 'force' = 'never',
) {
  const def = CARD_SCRIPTS[s.cards[source].defId].effects!.find((e) => e.label.startsWith(label))!;
  let r: RunResult = startEffect(s, ctx, source, def, undefined, chainMode);
  for (const c of choices) {
    if (r.kind !== 'running') break;
    if (c.pick) r = afterPick({ ...r.run, picked: c.pick }, ctx);
    if (r.kind === 'running' && c.zone) r = completeStep(r.run, ctx, c.zone);
  }
  if (r.kind === 'error') throw new Error(r.error);
  if (r.kind === 'running') throw new Error(`効果が未完了：${r.run.title}`);
  return { state: act(s, r.action), action: r.action };
}
const FILLER = ['14558127', '14558127', '23434538', '59438930', '42141493'];
function tank() {
  let s = createGame(TG_DECK, ctx, 1, FILLER);
  const larva = uid(s, '74627016');
  const gear = uid(s, '94350039');
  s = act(s, { type: 'SPECIAL_SUMMON', uid: gear, to: mz(0) });
  s = act(s, { type: 'SPECIAL_SUMMON', uid: larva, to: mz(1) });
  s = act(s, {
    type: 'PROCEDURE_SUMMON',
    method: 'synchro',
    uid: uid(s, '62560742'),
    materials: [gear, larva],
    to: mz(0),
  });
  return effect(s, larva, '②', [{ zone: mz(1) }]).state;
}
function suzuri() {
  let s = createGame(BLACKWING_DECK, ctx, 1, FILLER);
  const source = uid(s, '70465810');
  s = act(s, { type: 'SPECIAL_SUMMON', uid: source, to: mz(0) });
  return effect(s, source, '②', [{ pick: [source] }, { zone: mz(0) }]).state;
}
function radian(count = 2, holderId = '56111151') {
  let s = createGame(
    {
      name: 'ラディアンの効果検証',
      main: ['28674152', holderId, '73652465', '77152542', '14558127'],
      extra: ['9012916', '22850702'],
    },
    ctx,
    1,
  );
  const source = uid(s, '28674152');
  const holder = uid(s, holderId);
  s = act(s, { type: 'SPECIAL_SUMMON', uid: source, to: mz(0) });
  s = act(s, {
    type: 'MOVE',
    uid: holder,
    to: holderId === '56111151' ? { zone: 'fz' } : { zone: 'stz', index: 0 },
    faceUp: true,
  });
  s = act(s, { type: 'SET_COUNTERS', uid: holder, value: count });
  return { s, source, holder };
}
const generateRadian = (f = radian()) =>
  effect(f.s, f.source, '④', [{ pick: [f.holder] }, { pick: [f.holder] }, { zone: mz(1) }]);

const GENERATORS = [
  {
    id: '74627016',
    generate: tank,
    expected: {
      name: 'ＴＧトークン',
      level: 1,
      tuner: false,
      attribute: '地',
      race: '機械族',
      atk: 0,
      def: 0,
      archetypes: ['TG'],
    },
  },
  {
    id: '70465810',
    generate: suzuri,
    expected: { name: '幻耀トークン', level: 2, tuner: true, attribute: '闇', race: '鳥獣族', atk: 700, def: 700 },
  },
  {
    id: '28674152',
    generate: () => generateRadian().state,
    expected: {
      name: 'ラディアントークン',
      level: 7,
      tuner: false,
      attribute: '闇',
      race: '悪魔族',
      atk: 2800,
      def: 0,
      cannotBeSynchroMaterial: true,
    },
  },
];

describe('すべてのトークン生成効果', () => {
  it('収録された生成カードすべてに、本文に基づく生成結果の検証ケースがある', () => {
    const ids = Object.values(CARD_DB)
      .filter((d) => /「[^」]*トークン」/.test(d.text) && d.text.includes('特殊召喚'))
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(GENERATORS.map((g) => g.id).sort());
  });
  it.each(GENERATORS)(
    '$expected.name：本文どおりのレベル・チューナー区分・属性・種族・攻守で生成される',
    ({ generate, expected }) => {
      const s = generate();
      const u = token(s);
      expect(u).toBeTruthy();
      expect(s.mz.filter((u) => u && getDef(s, ctx, u).frame === 'token')).toHaveLength(1);
      expect(getDef(s, ctx, u)).toMatchObject({ kind: 'monster', frame: 'token', ...expected });
      if (expected.name === 'ＴＧトークン') expect(s.cards[u].position).toBe('atk');
      if (expected.name !== 'ＴＧトークン') expect(getDef(s, ctx, u).archetypes).toBeUndefined();
    },
  );

  it.each(HOLDER_CARDS)('$name：壊獣カウンター2つをコストとして正確に取り除く', ({ id }) => {
    const f = radian(3, id);
    const { state: s } = generateRadian(f);
    expect(s.cards[f.holder].counters).toBe(1);
    expect(token(s)).toBeTruthy();
    const replenished = act(s, { type: 'SET_COUNTERS', uid: f.holder, value: 2 });
    const again = startEffect(
      replenished,
      ctx,
      f.source,
      CARD_SCRIPTS['28674152'].effects!.find((e) => e.label.startsWith('④'))!,
    );
    expect(again.kind).toBe('error');
  });

  it('カウンター不足・裏側表示・他の種類のカウンターではラディアンを発動できない', () => {
    const def = CARD_SCRIPTS['28674152'].effects!.find((e) => e.label.startsWith('④'))!;
    const f = radian(1);
    expect(startEffect(f.s, ctx, f.source, def).kind).toBe('error');
    expect(f.s.cards[f.holder].counters).toBe(1);
    let s = act(f.s, { type: 'SET_COUNTERS', uid: f.holder, value: 2 });
    s = act(s, { type: 'MOVE', uid: f.holder, to: { zone: 'fz' }, faceUp: false });
    expect(startEffect(s, ctx, f.source, def).kind).toBe('error');
    s = act(s, { type: 'SET_COUNTERS', uid: f.source, value: 2 });
    expect(startEffect(s, ctx, f.source, def).kind).toBe('error');
    expect(token(s)).toBeUndefined();
  });

  it('自分と相手のフィールドから1つずつ取り除くこともできる', () => {
    const f = radian(1);
    let s = act(f.s, { type: 'OPP_PLACE', defId: '56111151', to: { zone: 'ofz' }, faceUp: true });
    const opponent = s.opp!.fz!;
    s = act(s, { type: 'SET_COUNTERS', uid: opponent, value: 1 });
    s = effect(s, f.source, '④', [{ pick: [f.holder] }, { pick: [opponent] }, { zone: mz(1) }]).state;
    expect(s.cards[f.holder].counters).toBe(0);
    expect(s.cards[opponent].counters).toBe(0);
    expect(token(s)).toBeTruthy();
  });

  it('効果を無効にされてもカウンターのコストは戻らず、トークンも生成されない', () => {
    const f = radian();
    let s = effect(f.s, f.source, '④', [{ pick: [f.holder] }, { pick: [f.holder] }], 'force').state;
    expect(s.cards[f.holder].counters).toBe(0);
    expect(token(s)).toBeUndefined();
    s = act(s, { type: 'CHAIN_NEGATE', index: 0, mode: 'effect', by: 'テスト' });
    const r = startResolve(s, ctx);
    if (r.kind !== 'done') throw new Error('無効にした効果を解決できません');
    s = act(s, r.action);
    expect(token(s)).toBeUndefined();
    expect(s.cards[f.holder].counters).toBe(0);
  });

  it('ラディアントークンは通常のS召喚・チューナー代用によるS召喚のどちらにも使えない', () => {
    const f = radian();
    let s = generateRadian(f).state;
    const u = token(s);
    const oroshi = uid(s, '73652465');
    const harmattan = uid(s, '77152542');
    s = act(s, { type: 'SPECIAL_SUMMON', uid: oroshi, to: mz(2) });
    const regular = applyAction(
      s,
      { type: 'PROCEDURE_SUMMON', method: 'synchro', uid: uid(s, '9012916'), materials: [u, oroshi], to: mz(1) },
      ctx,
    );
    expect(regular).toMatchObject({ ok: false });
    if (!regular.ok) expect(regular.error).toContain('S素材にできません');
    s = act(s, { type: 'SPECIAL_SUMMON', uid: harmattan, to: mz(3) });
    const substitute = applyAction(
      s,
      { type: 'PROC_SUMMON', uid: uid(s, '22850702'), proc: 0, materials: [u, oroshi, harmattan], to: mz(1) },
      ctx,
    );
    expect(substitute).toMatchObject({ ok: false });
    if (!substitute.ok) expect(substitute.error).toContain('S素材にできません');
    expect(
      enumerateActions(s, ctx).filter(
        (a) => a.type === 'PROCEDURE_SUMMON' && a.method === 'synchro' && a.materials.includes(u),
      ),
    ).toEqual([]);
  });

  it('保存・再生でもトークンの区分と素材制限が維持され、古い生成Actionも再生できる', () => {
    const f = radian();
    const result = generateRadian(f);
    const s = act(f.s, JSON.parse(JSON.stringify(result.action)) as Action);
    expect(s).toEqual(result.state);
    expect(getDef(s, ctx, token(s))).toMatchObject({ tuner: false, cannotBeSynchroMaterial: true });
    const legacy = act(f.s, { type: 'CREATE_TOKEN', name: '旧トークン', level: 1, atk: 0, def: 0, to: mz(1) });
    expect(!!getDef(legacy, ctx, token(legacy)).tuner).toBe(false);
  });

  it('トークン自身のカテゴリ・チューナー区分に特殊召喚制限を適用する', () => {
    const f = radian();
    const locked = act(f.s, { type: 'EXTRA_LOCK', source: 'ＴＧ限定の効果', filter: { archetype: 'TG' }, all: true });
    const action: Action = {
      type: 'CREATE_TOKEN',
      name: '幻耀トークン',
      level: 2,
      tuner: true,
      attribute: '闇',
      race: '鳥獣族',
      atk: 700,
      def: 700,
      to: mz(1),
    };
    expect(applyAction(locked, action, ctx).ok).toBe(false);
    expect(
      applyAction(
        locked,
        {
          ...action,
          name: 'ＴＧトークン',
          level: 1,
          tuner: false,
          attribute: '地',
          race: '機械族',
          atk: 0,
          def: 0,
          archetypes: ['TG'],
        },
        ctx,
      ).ok,
    ).toBe(true);
  });
});
