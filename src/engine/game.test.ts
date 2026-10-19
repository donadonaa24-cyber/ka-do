import { describe, expect, it } from 'vitest';
import { TEST_CARDS, TEST_DECK } from '../data/testCards';
import { type Action, applyAction, createGame, type Ctx, findLocation, replay } from './game';
import type { GameState } from './types';

const db = Object.fromEntries(TEST_CARDS.map((c) => [c.id, c]));
const ctx: Ctx = { db, options: { strict: true } };

function run(state: GameState, ...actions: Action[]): GameState {
  for (const a of actions) {
    const r = applyAction(state, a, ctx);
    if (!r.ok) throw new Error(r.error);
    state = r.state;
  }
  return state;
}

function err(state: GameState, action: Action): string {
  const r = applyAction(state, action, ctx);
  if (r.ok) throw new Error('エラーになるはずが成功した');
  return r.error;
}

const handOf = (s: GameState, defId: string, nth = 0) => s.hand.filter((u) => s.cards[u].defId === defId)[nth];
const extraOf = (s: GameState, defId: string, nth = 0) => s.extra.filter((u) => s.cards[u].defId === defId)[nth];
const deckOf = (s: GameState, defId: string) => s.deck.find((u) => s.cards[u].defId === defId)!;

describe('ゲーム開始', () => {
  it('初手5枚・先攻M1から始まる', () => {
    const s = createGame(TEST_DECK, ctx, 1);
    expect(s.hand).toHaveLength(5);
    expect(s.deck).toHaveLength(40 - 5);
    expect(s.extra).toHaveLength(13);
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('M1');
  });

  it('同じシードなら同じ初手', () => {
    const a = createGame(TEST_DECK, ctx, 42);
    const b = createGame(TEST_DECK, ctx, 42);
    expect(a.hand.map((u) => a.cards[u].defId)).toEqual(b.hand.map((u) => b.cards[u].defId));
  });

  it('6枚（後攻）で始めるとバトルフェイズを行える', () => {
    let s = createGame(TEST_DECK, ctx, 1, [], 6);
    expect(s.hand).toHaveLength(6);
    expect(s.turn).toBe(2);
    // ドローフェイズから始まる
    expect(s.phase).toBe('DP');
    s = run(s, { type: 'NEXT_PHASE', to: 'M1' }, { type: 'NEXT_PHASE' });
    expect(s.phase).toBe('BP');
  });

  it('初手指定ができる', () => {
    const s = createGame(TEST_DECK, ctx, 1, ['t-lv7', 't-tuner3']);
    const ids = s.hand.map((u) => s.cards[u].defId);
    expect(ids).toContain('t-lv7');
    expect(ids).toContain('t-tuner3');
  });
});

describe('通常召喚', () => {
  it('ターンに1度まで', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-lv4-a', 't-lv4-b']);
    s = run(s, { type: 'NORMAL_SUMMON', uid: handOf(s, 't-lv4-a'), index: 2 });
    expect(s.cards[s.mz[2]!].faceUp).toBe(true);
    expect(err(s, { type: 'NORMAL_SUMMON', uid: handOf(s, 't-lv4-b'), index: 1 })).toMatch('1度');
  });

  it('レベル7はリリース2体が必要', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-lv7', 't-lv4-a', 't-lv4-b']);
    const a = handOf(s, 't-lv4-a');
    const b = handOf(s, 't-lv4-b');
    s = run(
      s,
      { type: 'SPECIAL_SUMMON', uid: a, to: { zone: 'mz', index: 0 } },
      { type: 'SPECIAL_SUMMON', uid: b, to: { zone: 'mz', index: 1 } },
    );
    const dragon = handOf(s, 't-lv7');
    expect(err(s, { type: 'NORMAL_SUMMON', uid: dragon, index: 2, tributes: [a] })).toMatch('2体');
    s = run(s, { type: 'NORMAL_SUMMON', uid: dragon, index: 0, tributes: [a, b] });
    expect(s.mz[0]).toBe(dragon);
    expect(s.gy).toEqual([a, b]);
  });

  it('セットは裏側守備表示、次のターンに反転召喚できる', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-lv4-a']);
    const a = handOf(s, 't-lv4-a');
    s = run(s, { type: 'NORMAL_SUMMON', uid: a, index: 0, set: true });
    expect(s.cards[a]).toMatchObject({ faceUp: false, position: 'def' });
    expect(err(s, { type: 'FLIP_SUMMON', uid: a })).toMatch('セットしたターン');
    s = run(s, { type: 'NEXT_PHASE' }, { type: 'END_TURN' }, { type: 'NEXT_PHASE', to: 'M1' });
    s = run(s, { type: 'FLIP_SUMMON', uid: a });
    expect(s.cards[a]).toMatchObject({ faceUp: true, position: 'atk' });
  });
});

describe('フェイズとターン', () => {
  it('先攻1ターン目もBP・M2に入れるが、攻撃はできない', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-lv4-a']);
    s = run(s, { type: 'NORMAL_SUMMON', uid: s.hand.find((u) => s.cards[u].defId === 't-lv4-a')!, index: 0 });
    s = run(s, { type: 'NEXT_PHASE' });
    expect(s.phase).toBe('BP');
    expect(err(s, { type: 'ATTACK', uid: s.mz[0]! })).toMatch('先攻1ターン目');
    s = run(s, { type: 'NEXT_PHASE' });
    expect(s.phase).toBe('M2');
    s = run(s, { type: 'NEXT_PHASE' });
    expect(s.phase).toBe('EP');
  });

  it('2ターン目はドローする', () => {
    let s = createGame(TEST_DECK, ctx, 1);
    s = run(s, { type: 'NEXT_PHASE', to: 'EP' }, { type: 'NEXT_PHASE' });
    expect(s.turn).toBe(2);
    expect(s.phase).toBe('DP');
    expect(s.hand).toHaveLength(6);
    expect(s.normalSummonUsed).toBe(false);
  });

  it('手札7枚以上ではターンを終えられない', () => {
    let s = createGame(TEST_DECK, ctx, 1);
    s = run(s, { type: 'DRAW', count: 2 });
    expect(err(s, { type: 'END_TURN' })).toMatch('6枚');
  });

  it('デッキが0枚でドローすると敗北', () => {
    let s = createGame(TEST_DECK, ctx, 1);
    s = run(s, { type: 'DRAW', count: 36 });
    expect(s.status).toBe('lost');
  });

  it('2ターン目のBPで直接攻撃できる', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-lv4-a']);
    const a = handOf(s, 't-lv4-a');
    s = run(s, { type: 'NORMAL_SUMMON', uid: a, index: 0 }, { type: 'END_TURN' }, { type: 'NEXT_PHASE', to: 'BP' });
    s = run(
      s,
      { type: 'ATTACK', uid: a },
      {
        type: 'BATCH',
        actions: [{ type: 'BATTLE_STEP' }, { type: 'BATTLE_STEP' }, { type: 'BATTLE_STEP' }, { type: 'BATTLE_STEP' }],
      },
    );
    expect(s.opponentLp).toBe(8000 - 1800);
    expect(err(s, { type: 'ATTACK', uid: a })).toMatch('既に攻撃');
  });
});

describe('EXデッキからの召喚', () => {
  function withTwoMonsters() {
    let s = createGame(TEST_DECK, ctx, 1, ['t-lv4-a', 't-lv4-b', 't-tuner3']);
    const a = handOf(s, 't-lv4-a');
    const b = handOf(s, 't-lv4-b');
    const t = handOf(s, 't-tuner3');
    s = run(
      s,
      { type: 'SPECIAL_SUMMON', uid: a, to: { zone: 'mz', index: 0 } },
      { type: 'SPECIAL_SUMMON', uid: b, to: { zone: 'mz', index: 1 } },
    );
    return { s, a, b, t };
  }

  it('リンクモンスターはEXゾーンかリンク先にしか出せない', () => {
    const { s, a, b } = withTwoMonsters();
    const link = extraOf(s, 't-link2');
    expect(
      err(s, { type: 'PROCEDURE_SUMMON', method: 'link', uid: link, materials: [a, b], to: { zone: 'mz', index: 2 } }),
    ).toMatch('リンク先');
    const s2 = run(s, {
      type: 'PROCEDURE_SUMMON',
      method: 'link',
      uid: link,
      materials: [a, b],
      to: { zone: 'emz', index: 0 },
    });
    expect(s2.emz[0]).toBe(link);
    // EMZ(左)=列1 の ↙↘ は メインゾーン 0 と 2
    const link1 = extraOf(s2, 't-link1');
    let s3 = run(s2, { type: 'SPECIAL_SUMMON', uid: handOf(s2, 't-tuner3'), to: { zone: 'mz', index: 4 } });
    const t = s3.mz[4]!;
    expect(
      err(s3, { type: 'PROCEDURE_SUMMON', method: 'link', uid: link1, materials: [t], to: { zone: 'emz', index: 1 } }),
    ).toMatch('1つ');
    s3 = run(s3, {
      type: 'PROCEDURE_SUMMON',
      method: 'link',
      uid: link1,
      materials: [t],
      to: { zone: 'mz', index: 2 },
    });
    expect(s3.mz[2]).toBe(link1);
  });

  it('メインデッキのモンスターはEXモンスターゾーンに出せない', () => {
    const { s, t } = withTwoMonsters();
    expect(err(s, { type: 'SPECIAL_SUMMON', uid: t, to: { zone: 'emz', index: 0 } })).toMatch('EXデッキから');
  });

  it('リンク素材はリンクモンスターをリンクマーカー数として数えられる', () => {
    const { s, a, b, t } = withTwoMonsters();
    const link2 = extraOf(s, 't-link2');
    let s2 = run(
      s,
      { type: 'PROCEDURE_SUMMON', method: 'link', uid: link2, materials: [a, b], to: { zone: 'emz', index: 0 } },
      { type: 'SPECIAL_SUMMON', uid: t, to: { zone: 'mz', index: 0 } },
    );
    const link3 = extraOf(s2, 't-link3');
    s2 = run(s2, {
      type: 'PROCEDURE_SUMMON',
      method: 'link',
      uid: link3,
      materials: [link2, t],
      to: { zone: 'emz', index: 0 },
    });
    expect(s2.emz[0]).toBe(link3);
    // リンクモンスターは墓地へ
    expect(findLocation(s2, link2)).toEqual({ zone: 'gy' });
  });

  it('シンクロ召喚はレベル合計が一致する必要がある', () => {
    const { s, a, t } = withTwoMonsters();
    const s2 = run(s, { type: 'SPECIAL_SUMMON', uid: t, to: { zone: 'mz', index: 2 } });
    const syn = extraOf(s2, 't-synchro7');
    const s3 = run(s2, {
      type: 'PROCEDURE_SUMMON',
      method: 'synchro',
      uid: syn,
      materials: [t, a],
      to: { zone: 'mz', index: 3 },
    });
    expect(s3.mz[3]).toBe(syn);
    const b = s.mz[1]!;
    expect(
      err(s3, {
        type: 'PROCEDURE_SUMMON',
        method: 'synchro',
        uid: extraOf(s3, 't-synchro7'),
        materials: [b],
        to: { zone: 'mz', index: 4 },
      }),
    ).toMatch('チューナー');
  });

  it('エクシーズ召喚の素材は重なり、離れると墓地へ', () => {
    const { s, a, b } = withTwoMonsters();
    const x = extraOf(s, 't-xyz4');
    let s2 = run(s, {
      type: 'PROCEDURE_SUMMON',
      method: 'xyz',
      uid: x,
      materials: [a, b],
      to: { zone: 'mz', index: 0 },
    });
    expect(s2.cards[x].overlay).toEqual([a, b]);
    expect(s2.gy).toEqual([]);
    s2 = run(s2, { type: 'DETACH', target: x, uid: a });
    expect(s2.gy).toEqual([a]);
    s2 = run(s2, { type: 'MOVE', uid: x, to: { zone: 'hand' } });
    // EXデッキのモンスターは手札ではなくEXデッキへ戻り、素材は墓地へ
    expect(findLocation(s2, x)).toEqual({ zone: 'extra' });
    expect(s2.gy).toEqual([a, b]);
  });

  it('儀式召喚', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-ritual', 't-lv4-a', 't-tuner3']);
    const r = handOf(s, 't-ritual');
    const a = handOf(s, 't-lv4-a');
    const t = handOf(s, 't-tuner3');
    expect(
      err(s, { type: 'PROCEDURE_SUMMON', method: 'ritual', uid: r, materials: [a], to: { zone: 'mz', index: 0 } }),
    ).toMatch('足りません');
    s = run(s, { type: 'PROCEDURE_SUMMON', method: 'ritual', uid: r, materials: [a, t], to: { zone: 'mz', index: 0 } });
    expect(s.mz[0]).toBe(r);
  });
});

describe('魔法・罠', () => {
  it('通常魔法は発動→解決で墓地へ', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-spell-search']);
    const sp = handOf(s, 't-spell-search');
    s = run(s, { type: 'ACTIVATE_CARD', uid: sp });
    expect(s.cards[sp].pendingResolve).toBe(true);
    const target = deckOf(s, 't-lv7');
    s = run(s, { type: 'MOVE', uid: target, to: { zone: 'hand' }, reason: 'サーチ' }, { type: 'RESOLVE', uid: sp });
    expect(s.gy).toEqual([sp]);
    expect(s.hand).toContain(target);
  });

  it('罠はセットしたターンに発動できない', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-trap']);
    const tr = handOf(s, 't-trap');
    expect(err(s, { type: 'ACTIVATE_CARD', uid: tr })).toMatch('セット');
    s = run(s, { type: 'SET_SPELL_TRAP', uid: tr });
    expect(err(s, { type: 'ACTIVATE_CARD', uid: tr })).toMatch('セットしたターン');
    s = run(s, { type: 'END_TURN' }, { type: 'ACTIVATE_CARD', uid: tr });
    expect(s.cards[tr].faceUp).toBe(true);
  });

  it('フィールド魔法は張り替えると古い方が墓地へ', () => {
    let s = createGame(TEST_DECK, ctx, 3, ['t-spell-field', 't-spell-field']);
    const [f1, f2] = s.hand.filter((u) => s.cards[u].defId === 't-spell-field');
    s = run(s, { type: 'ACTIVATE_CARD', uid: f1 }, { type: 'ACTIVATE_CARD', uid: f2 });
    expect(s.fz).toBe(f2);
    expect(s.gy).toEqual([f1]);
  });
});

describe('その他', () => {
  it('トークンはフィールドを離れると消滅する', () => {
    let s = createGame(TEST_DECK, ctx, 1);
    s = run(s, {
      type: 'CREATE_TOKEN',
      name: 'テストトークン',
      level: 1,
      atk: 0,
      def: 0,
      to: { zone: 'mz', index: 0 },
    });
    const tok = s.mz[0]!;
    s = run(s, { type: 'MOVE', uid: tok, to: { zone: 'gy' } });
    expect(s.cards[tok]).toBeUndefined();
    expect(s.gy).toEqual([]);
  });

  it('効果の使用回数を記録して2回目は警告する', () => {
    let s = createGame(TEST_DECK, ctx, 1, ['t-lv4-a']);
    const a = handOf(s, 't-lv4-a');
    s = run(s, { type: 'ACTIVATE_EFFECT', uid: a }, { type: 'ACTIVATE_EFFECT', uid: a });
    expect(s.effectUses['テスト戦士A']).toBe(2);
    expect(s.log.at(-1)!.kind).toBe('warn');
  });

  it('リプレイで同じ盤面を再現できる', () => {
    const init = createGame(TEST_DECK, ctx, 7);
    const actions: Action[] = [{ type: 'SHUFFLE_DECK' }, { type: 'DRAW' }, { type: 'MILL', count: 3 }];
    const a = replay(init, actions, ctx);
    const b = replay(createGame(TEST_DECK, ctx, 7), actions, ctx);
    expect(a.gy.map((u) => a.cards[u].defId)).toEqual(b.gy.map((u) => b.cards[u].defId));
  });

  it('ルールチェックを切ると自由に動かせる', () => {
    const free: Ctx = { db, options: { strict: false } };
    let s = createGame(TEST_DECK, free, 1, ['t-lv4-a', 't-lv4-b']);
    for (const uid of [handOf(s, 't-lv4-a'), handOf(s, 't-lv4-b')]) {
      const r = applyAction(s, { type: 'NORMAL_SUMMON', uid, index: s.mz.indexOf(null) }, free);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.state;
    }
  });
});
