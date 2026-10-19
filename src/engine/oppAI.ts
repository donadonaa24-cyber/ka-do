import { type Action, type Ctx, findLocation, getDef, oppFieldCards, oppMonsterSlots } from './game';
import { effectText } from './scripts';
import type { ChainLink, GameState } from './types';

// 練習用の相手AI：相手の盤面に置いたカードの妨害を、こちらの効果の発動にチェーンして使ってくる。
// 1回の発動に使う妨害は1つ。安く使えるものから順に使う。

interface Ability {
  id: string;
  card: string;
  label: string;
  speed: number;
  /** 使える妨害なら、使うカード（と対象）を返す */
  find: (s: GameState, ctx: Ctx, link: ChainLink) => { uid: string; target?: string; cost: Action[] } | null;
  /** 解決したときの処理 */
  resolve: (s: GameState, ctx: Ctx, link: ChainLink) => Action[];
}

const def = (s: GameState, ctx: Ctx, uid: string) => getDef(s, ctx, uid);
const faceUpOpp = (s: GameState, uids: (string | null)[]) => uids.filter((u): u is string => !!u && s.cards[u].faceUp);
const oppMonsters = (s: GameState) => faceUpOpp(s, s.opp ? oppMonsterSlots(s.opp) : []);
const findOpp = (s: GameState, ctx: Ctx, uids: (string | null)[], name: string) =>
  uids.find((u): u is string => !!u && def(s, ctx, u).name === name);
const used = (s: GameState, key: string) => (s.effectUses[key] ?? 0) > 0;

/** 相手フィールドに「トゥーン・ワールド」として扱うカードとトゥーンモンスターがいるか */
function toonReady(s: GameState, ctx: Ctx): boolean {
  const o = s.opp;
  if (!o) return false;
  const world = [o.fz, ...o.stz].some(
    (u) =>
      !!u && s.cards[u].faceUp && (def(s, ctx, u).treatedAsToonWorld || def(s, ctx, u).name === 'トゥーン・ワールド'),
  );
  return world && oppMonsters(s).some((u) => def(s, ctx, u).toon);
}

/** チェーンの発動元が魔法・罠カードか */
const isSpellTrap = (s: GameState, ctx: Ctx, link: ChainLink) => def(s, ctx, link.uid).kind !== 'monster';

/** 「発動を無効にし破壊」「効果を無効」の解決 */
const negate =
  (mode: 'destroy' | 'effect', by: string, after: (s: GameState, link: ChainLink) => Action[] = () => []) =>
  (s: GameState, _ctx: Ctx, link: ChainLink): Action[] => [
    ...(link.targetLink !== undefined && s.chain[link.targetLink]
      ? [{ type: 'CHAIN_NEGATE', index: link.targetLink, mode, by } as Action]
      : []),
    ...after(s, link),
  ];

/** チェーンの効果のテキスト（その①②…の部分）・発動したカード */
function linkInfo(s: GameState, ctx: Ctx, link: ChainLink) {
  const d = def(s, ctx, link.uid);
  const eff = ctx.scripts?.[link.defId]?.effects?.[link.effect];
  let text = eff ? effectText(d.text, eff.label) : d.text;
  // 番号の無い「発動」：通常・速攻魔法と罠は①が発動時の効果。フィールド・永続魔法などは発動時の効果処理だけ
  if (eff && !/^[①-⑳]/.test(eff.label) && /①：/.test(d.text)) {
    const lasting = d.spellType === 'field' || d.spellType === 'continuous' || d.trapType === 'continuous';
    text = eff.isCardActivation
      ? lasting
        ? (d.text.match(/発動時の効果処理として[^。]*。/)?.[0] ?? '')
        : effectText(d.text, '①')
      : text;
  }
  return { d, eff, text };
}
/** 相手の手札のそのカード */
const inHand = (s: GameState, ctx: Ctx, name: string) => findOpp(s, ctx, s.opp?.hand ?? [], name);
/** 相手の魔法＆罠ゾーンに伏せたそのカード */
const setCard = (s: GameState, ctx: Ctx, name: string) =>
  (s.opp?.stz ?? []).find((u): u is string => !!u && !s.cards[u].faceUp && def(s, ctx, u).name === name);
/** こちら（効果を発動した側）のフィールドのカード */
const playerField = (s: GameState) => [...s.mz, ...s.emz, ...s.stz, s.fz].filter((u): u is string => !!u);
/** 発動したカードが今フィールドにある */
const sourceOnField = (s: GameState, link: ChainLink) => {
  const loc = findLocation(s, link.uid);
  return !!loc && ['mz', 'emz', 'stz', 'fz'].includes(loc.zone);
};
/** フィールドで発動したモンスター効果 */
const fieldMonsterEffect = (s: GameState, ctx: Ctx, link: ChainLink) =>
  link.from === 'monster' && def(s, ctx, link.uid).kind === 'monster' && sourceOnField(s, link);
const mainPhase = (s: GameState) => s.phase === 'M1' || s.phase === 'M2';
const discard = (uid: string): Action => ({ type: 'MOVE', uid, to: { zone: 'gy' }, reason: 'コスト' });
const toGyAfter = (uid: string): Action => ({ type: 'MOVE', uid, to: { zone: 'gy' }, reason: '発動後に墓地へ' });
/** 伏せたカードを表にして発動、または手札から発動（発動したら墓地へ） */
const activateTrap = (s: GameState, uid: string, key: string): Action[] => [
  { type: 'OPP_USE', uid, key },
  ...(findLocation(s, uid)?.zone === 'ostz' ? [{ type: 'OPP_EDIT', uid, faceUp: true } as Action] : []),
];

/** 相手（CPU）のモンスターの、相手ターンに使える妨害（1ターンに1度など） */
const monsterAbility = (
  id: string,
  card: string,
  label: string,
  when: (s: GameState, ctx: Ctx, link: ChainLink) => boolean,
  mode: 'destroy' | 'effect',
  key: (s: GameState, ctx: Ctx, link: ChainLink) => string = () => `opp:${card}`,
): Ability => ({
  id,
  card,
  label,
  speed: 2,
  find: (s, ctx, link) => {
    const uid = findOpp(s, ctx, oppMonsters(s), card);
    if (!uid || s.cards[uid].negatedTurn === s.turn || !when(s, ctx, link)) return null;
    const k = key(s, ctx, link);
    return used(s, k) ? null : { uid, cost: [{ type: 'OPP_USE', uid, key: k }] };
  },
  resolve: negate(mode, card),
});

const PSY_DRIVER = 'ＰＳＹフレーム・ドライバー';
/** 相手の手札・デッキ・墓地の「ＰＳＹフレーム・ドライバー」 */
const oppDriver = (s: GameState, ctx: Ctx) =>
  findOpp(s, ctx, [...(s.opp?.hand ?? []), ...(s.opp?.deck ?? []), ...(s.opp?.gy ?? [])], PSY_DRIVER);

/**
 * ＰＳＹフレームギア（γ・δ）：手札のこのカードと手札・デッキ・墓地の「ＰＳＹフレーム・ドライバー」を特殊召喚し、
 * その発動を無効にし破壊する。特殊召喚したモンスターはエンドフェイズに除外される。
 * 練習（相手のデッキが無い）ではドライバーはデッキにあるものとして置く
 */
function psyGear(
  id: string,
  card: string,
  label: string,
  when: (s: GameState, ctx: Ctx, link: ChainLink) => boolean,
): Ability {
  return {
    id,
    card,
    label,
    speed: 2,
    find: (s, ctx, link) => {
      const uid = inHand(s, ctx, card);
      if (!uid || oppMonsters(s).length || !when(s, ctx, link)) return null;
      if (s.opp?.deck && !oppDriver(s, ctx)) return null;
      if (s.opp!.mz.filter((u) => !u).length < 2) return null;
      return { uid, cost: [] };
    },
    resolve: (s, ctx, link) => {
      const o = s.opp!;
      const free = o.mz.flatMap((u, i) => (u ? [] : [i]));
      const out: Action[] = [];
      if (findLocation(s, link.uid)?.zone === 'ohand' && free.length >= 2) {
        const driver = oppDriver(s, ctx);
        const driverId = Object.values(ctx.db).find((d) => d.name === PSY_DRIVER)?.id;
        out.push(
          {
            type: 'MOVE',
            uid: link.uid,
            to: { zone: 'omz', index: free[0] },
            faceUp: true,
            position: 'atk',
            reason: '自身の効果で特殊召喚',
          },
          { type: 'BANISH_AT_END', uid: link.uid },
        );
        if (driver)
          out.push(
            {
              type: 'MOVE',
              uid: driver,
              to: { zone: 'omz', index: free[1] },
              faceUp: true,
              position: 'atk',
              reason: `${card}の効果で特殊召喚`,
            },
            { type: 'BANISH_AT_END', uid: driver },
          );
        else if (!o.deck && driverId)
          out.push({
            type: 'OPP_PLACE',
            defId: driverId,
            to: { zone: 'omz', index: free[1] },
            faceUp: true,
            position: 'atk',
            banishAtEnd: true,
          });
      }
      return [...out, ...negate('destroy', card)(s, ctx, link)];
    },
  };
}

/** 手札誘発・相手ターンに使える罠など（CPUが使う・CPU戦でプレイヤーが使う） */
const HAND_TRAP_ABILITIES: Ability[] = [
  monsterAbility(
    'magician',
    '究極竜魔導師',
    '① 魔法・罠・モンスターの効果の発動を無効にし破壊（種類ごとに1度）',
    () => true,
    'destroy',
    (s, ctx, link) => `opp:究極竜魔導師:${def(s, ctx, link.uid).kind}`,
  ),
  monsterAbility(
    'sifr',
    '聖珖神竜 スターダスト・シフル',
    '② モンスター効果の発動を無効にし破壊',
    (s, ctx, link) => def(s, ctx, link.uid).kind === 'monster',
    'destroy',
  ),
  monsterAbility(
    'ultimate-spirit',
    '青眼の究極霊竜',
    '② フィールドで発動した効果を無効にし破壊',
    (_s, _ctx, link) => ['monster', 'spelltrap', 'field-zone'].includes(link.from ?? ''),
    'destroy',
  ),
  monsterAbility(
    'spirit',
    '青眼の精霊龍',
    '② 墓地のカードの効果の発動を無効',
    (_s, _ctx, link) => link.from === 'gy',
    'effect',
  ),
  {
    id: 'dragoon',
    card: '超魔導竜騎士－ドラグーン・オブ・レッドアイズ',
    label: '② 手札を1枚捨て、効果の発動を無効にし破壊',
    speed: 2,
    find: (s, ctx) => {
      const uid = findOpp(s, ctx, oppMonsters(s), '超魔導竜騎士－ドラグーン・オブ・レッドアイズ');
      const hand = s.opp?.hand ?? [];
      // 手札誘発は残し、それ以外を捨てる
      const cost = hand.find((u) => !HAND_TRAP_NAMES.has(def(s, ctx, u).name)) ?? hand[0];
      if (!uid || !cost || used(s, 'opp:ドラグーン②')) return null;
      return { uid, cost: [{ type: 'OPP_USE', uid, key: 'opp:ドラグーン②' }, discard(cost)] };
    },
    resolve: negate('destroy', '超魔導竜騎士－ドラグーン・オブ・レッドアイズ'),
  },
  {
    id: 'psalm',
    card: '列王詩篇',
    label: '① フィールドのモンスター効果の発動を無効',
    speed: 2,
    find: (s, ctx, link) => {
      const uid = setCard(s, ctx, '列王詩篇');
      if (!uid || used(s, 'opp:列王詩篇') || !fieldMonsterEffect(s, ctx, link)) return null;
      return { uid, cost: activateTrap(s, uid, 'opp:列王詩篇') };
    },
    resolve: negate('effect', '列王詩篇', (_, link) => [toGyAfter(link.uid)]),
  },
  {
    id: 'crush',
    card: '聖王の粉砕',
    label: '① デッキからカードを手札に加える効果を無効（墓地に罠があれば破壊）',
    speed: 2,
    find: (s, ctx, link) => {
      if (used(s, 'opp:聖王の粉砕')) return null;
      const { text } = linkInfo(s, ctx, link);
      if (!/デッキ/.test(text) || !/手札に加え/.test(text)) return null;
      // 相手フィールドにカードがあれば手札からも発動できる
      const uid = setCard(s, ctx, '聖王の粉砕') ?? (playerField(s).length ? inHand(s, ctx, '聖王の粉砕') : undefined);
      return uid ? { uid, cost: activateTrap(s, uid, 'opp:聖王の粉砕') } : null;
    },
    resolve: (s, ctx, link) => {
      const trapInGy = (s.opp?.gy ?? []).some((u) => def(s, ctx, u).kind === 'trap');
      return negate(trapInGy ? 'destroy' : 'effect', '聖王の粉砕', () => [toGyAfter(link.uid)])(s, ctx, link);
    },
  },
  {
    id: 'reiou',
    card: '霊王の波動',
    label: '① 特殊召喚する効果を含む効果の発動を無効にし破壊',
    speed: 3,
    find: (s, ctx, link) => {
      if (used(s, 'opp:霊王の波動') || !/特殊召喚/.test(linkInfo(s, ctx, link).text)) return null;
      const uid = setCard(s, ctx, '霊王の波動') ?? (playerField(s).length ? inHand(s, ctx, '霊王の波動') : undefined);
      return uid ? { uid, cost: activateTrap(s, uid, 'opp:霊王の波動') } : null;
    },
    resolve: negate('destroy', '霊王の波動', (_, link) => [toGyAfter(link.uid)]),
  },
  {
    id: 'imperm',
    card: '無限泡影',
    label: '① フィールドの効果モンスターの効果をターン終了時まで無効',
    speed: 2,
    find: (s, ctx, link) => {
      if (used(s, 'opp:無限泡影') || !fieldMonsterEffect(s, ctx, link)) return null;
      // 自分フィールドにカードが無ければ手札からも発動できる
      const uid = setCard(s, ctx, '無限泡影') ?? (oppFieldCards(s).length ? undefined : inHand(s, ctx, '無限泡影'));
      return uid ? { uid, cost: activateTrap(s, uid, 'opp:無限泡影') } : null;
    },
    resolve: (s, _ctx, link) => {
      const target = s.chain[link.targetLink!];
      return [
        ...(target
          ? [{ type: 'CHAIN_NEGATE', index: link.targetLink!, mode: 'effect', by: '無限泡影' } as Action]
          : []),
        ...(target && sourceOnField(s, target)
          ? [{ type: 'NEGATE_CARD', uid: target.uid, by: '無限泡影' } as Action]
          : []),
        toGyAfter(link.uid),
      ];
    },
  },
  {
    id: 'ash',
    card: '灰流うらら',
    label: '① 手札から捨てて、デッキからのサーチ・特殊召喚・墓地送りを含む効果を無効',
    speed: 2,
    find: (s, ctx, link) => {
      const uid = inHand(s, ctx, '灰流うらら');
      const { text } = linkInfo(s, ctx, link);
      if (!uid || used(s, 'opp:灰流うらら') || !/デッキ/.test(text)) return null;
      if (!/(手札に加え|特殊召喚|墓地へ送)/.test(text)) return null;
      return { uid, cost: [{ type: 'OPP_USE', uid, key: 'opp:灰流うらら' }, discard(uid)] };
    },
    resolve: negate('effect', '灰流うらら'),
  },
  {
    id: 'veiler',
    card: 'エフェクト・ヴェーラー',
    label: '① 手札から捨てて、フィールドの効果モンスターの効果をターン終了時まで無効',
    speed: 2,
    find: (s, ctx, link) => {
      const uid = inHand(s, ctx, 'エフェクト・ヴェーラー');
      if (!uid || !mainPhase(s) || !fieldMonsterEffect(s, ctx, link)) return null;
      return { uid, cost: [discard(uid)] };
    },
    resolve: (s, _ctx, link) => {
      const target = s.chain[link.targetLink!];
      return target
        ? [
            { type: 'CHAIN_NEGATE', index: link.targetLink!, mode: 'effect', by: 'エフェクト・ヴェーラー' } as Action,
            ...(sourceOnField(s, target)
              ? [{ type: 'NEGATE_CARD', uid: target.uid, by: 'エフェクト・ヴェーラー' } as Action]
              : []),
          ]
        : [];
    },
  },
  {
    id: 'ghost',
    card: '幽鬼うさぎ',
    label: '① 墓地へ送り、効果を発動したフィールドのカードを破壊',
    speed: 2,
    find: (s, ctx, link) => {
      const uid = inHand(s, ctx, '幽鬼うさぎ') ?? findOpp(s, ctx, oppMonsters(s), '幽鬼うさぎ');
      if (!uid || used(s, 'opp:幽鬼うさぎ') || !sourceOnField(s, link)) return null;
      return { uid, target: link.uid, cost: [{ type: 'OPP_USE', uid, key: 'opp:幽鬼うさぎ' }, discard(uid)] };
    },
    resolve: (s, _ctx, link) =>
      link.target && sourceOnField(s, { ...link, uid: link.target })
        ? [{ type: 'MOVE', uid: link.target, to: { zone: 'gy' }, reason: '効果で破壊' }]
        : [],
  },
  psyGear(
    'psy-gamma',
    'ＰＳＹフレームギア・γ',
    '① ドライバーと特殊召喚し、モンスター効果の発動を無効にし破壊（自分フィールドにモンスターがいない時）',
    (s, ctx, link) => def(s, ctx, link.uid).kind === 'monster',
  ),
  psyGear(
    'psy-delta',
    'ＰＳＹフレームギア・δ',
    '① ドライバーと特殊召喚し、魔法カードの発動を無効にし破壊（自分フィールドにモンスターがいない時）',
    (s, ctx, link) => {
      const { d, eff } = linkInfo(s, ctx, link);
      return d.kind === 'spell' && !!eff?.isCardActivation;
    },
  ),
];

/** 手札誘発として扱うカード（ドラグーンのコストで残す） */
const HAND_TRAP_NAMES = new Set([
  '灰流うらら',
  'エフェクト・ヴェーラー',
  '無限泡影',
  '幽鬼うさぎ',
  'ＰＳＹフレームギア・γ',
  'ＰＳＹフレームギア・δ',
  '霊王の波動',
  '聖王の粉砕',
]);

const ABILITIES: Ability[] = [
  {
    id: 'georgias',
    card: 'ドラグニティロード－ゲオルギアス',
    label: '③ 装備カードを墓地へ送り、魔法・罠の効果を無効にする',
    speed: 2,
    find: (s, ctx, link) => {
      if (!isSpellTrap(s, ctx, link) || used(s, 'opp:ゲオルギアス③')) return null;
      const uid = findOpp(s, ctx, oppMonsters(s), 'ドラグニティロード－ゲオルギアス');
      // 装備カード（魔法＆罠ゾーンに表側で置いたモンスターカード）をコストにする
      const equip = faceUpOpp(s, s.opp?.stz ?? []).find((u) => def(s, ctx, u).kind === 'monster');
      if (!uid || !equip) return null;
      return {
        uid,
        cost: [
          { type: 'OPP_USE', uid, key: 'opp:ゲオルギアス③' },
          { type: 'MOVE', uid: equip, to: { zone: 'gy' }, reason: 'コスト' },
        ],
      };
    },
    resolve: negate('effect', 'ドラグニティロード－ゲオルギアス'),
  },
  {
    id: 'terror',
    card: 'トゥーン・テラー',
    label: '発動を無効にし破壊する',
    speed: 3,
    find: (s, ctx) => {
      if (used(s, 'opp:トゥーン・テラー') || !toonReady(s, ctx)) return null;
      const uid = (s.opp?.stz ?? []).find(
        (u) => !!u && !s.cards[u].faceUp && def(s, ctx, u).name === 'トゥーン・テラー',
      );
      if (!uid) return null;
      return {
        uid,
        cost: [
          { type: 'OPP_USE', uid, key: 'opp:トゥーン・テラー' },
          { type: 'OPP_EDIT', uid, faceUp: true },
        ],
      };
    },
    resolve: negate('destroy', 'トゥーン・テラー', (_, link) => [
      { type: 'MOVE', uid: link.uid, to: { zone: 'gy' }, reason: '発動後に墓地へ' },
    ]),
  },
  {
    id: 'baroness',
    card: 'フルール・ド・バロネス',
    label: '② 発動を無効にし破壊する（表側で存在する限り1度だけ）',
    speed: 2,
    find: (s, ctx) => {
      const uid = oppMonsters(s).find(
        (u) => def(s, ctx, u).name === 'フルール・ド・バロネス' && !s.cards[u].oppSpent?.includes('baroness2'),
      );
      return uid ? { uid, cost: [{ type: 'OPP_USE', uid, key: 'baroness2', once: true }] } : null;
    },
    resolve: negate('destroy', 'フルール・ド・バロネス'),
  },
  {
    id: 'abao',
    card: '光なき影 ア＝バオ・ア・クゥー',
    label: '① 手札を1枚捨て、フィールドのカード1枚を破壊する',
    speed: 2,
    find: (s, ctx, link) => {
      if (used(s, 'opp:ア＝バオ①') || (s.phase !== 'M1' && s.phase !== 'M2')) return null;
      const uid = findOpp(s, ctx, oppMonsters(s), '光なき影 ア＝バオ・ア・クゥー');
      const discard = s.opp?.hand[0];
      if (!uid || !discard) return null;
      const target = destroyTarget(s, ctx, link);
      if (!target) return null;
      return {
        uid,
        target,
        cost: [
          { type: 'OPP_USE', uid, key: 'opp:ア＝バオ①' },
          { type: 'MOVE', uid: discard, to: { zone: 'gy' }, reason: 'コスト' },
        ],
      };
    },
    resolve: (s, _ctx, link) => {
      const t = link.target;
      const loc = t ? findLocation(s, t) : null;
      const onField = !!loc && ['mz', 'emz', 'stz', 'fz'].includes(loc.zone);
      return onField ? [{ type: 'MOVE', uid: t!, to: { zone: 'gy' }, reason: '効果で破壊' }] : [];
    },
  },
  ...HAND_TRAP_ABILITIES,
];

/** ア＝バオ・ア・クゥーで破壊するカード：効果を発動したフィールドのモンスター、いなければ攻撃力が一番高いモンスター */
function destroyTarget(s: GameState, ctx: Ctx, link: ChainLink): string | null {
  const loc = findLocation(s, link.uid);
  if (loc && (loc.zone === 'mz' || loc.zone === 'emz')) return link.uid;
  const mons = [...s.mz, ...s.emz].filter((u): u is string => !!u);
  if (mons.length) return mons.sort((a, b) => (def(s, ctx, b).atk ?? 0) - (def(s, ctx, a).atk ?? 0))[0];
  const st = [...s.stz, s.fz].filter((u): u is string => !!u && s.cards[u].faceUp);
  return st[0] ?? null;
}

/** チェーンの一番上（こちらの発動）に相手が妨害をチェーンするなら、その操作を返す */
export function oppResponse(s: GameState, ctx: Ctx): Action[] | null {
  const top = s.chain[s.chain.length - 1];
  if (!top || top.opp || s.cards[top.uid]?.opp || !s.opp) return null;
  for (const a of ABILITIES) {
    if (a.speed < top.speed) continue;
    const found = a.find(s, ctx, top);
    if (!found) continue;
    return [
      ...found.cost,
      {
        type: 'CHAIN_PUSH',
        uid: found.uid,
        effect: -1,
        stepStart: 0,
        speed: a.speed,
        label: a.label,
        opp: a.id,
        targetLink: s.chain.length - 1,
        target: found.target,
      },
    ];
  }
  return null;
}

/** 相手の妨害のチェーンを解決する操作 */
export function resolveOppLink(s: GameState, ctx: Ctx, link: ChainLink): Action[] {
  const a = ABILITIES.find((x) => x.id === link.opp);
  return a ? a.resolve(s, ctx, link) : [];
}

/** 妨害を持つ相手のカード（プリセット・説明用） */
export const OPP_DISRUPTION_CARDS = ABILITIES.map((a) => ({ card: a.card, label: a.label }));

/** このカードの効果を（スペルスピード speed で）発動したら、相手が妨害してくるか */
export function oppWouldRespond(s: GameState, ctx: Ctx, uid: string, speed: number): boolean {
  if (!s.opp || !s.cards[uid]) return false;
  const link: ChainLink = { uid, defId: s.cards[uid].defId, effect: 0, stepStart: 0, speed, label: '' };
  return !!oppResponse({ ...s, chain: [...s.chain, link] }, ctx);
}

/** 指定した妨害（CPU戦でプレイヤーが選んだ手札誘発など）を、チェーンの一番上に使う操作。使えなければ null */
export function forceOppResponse(s: GameState, ctx: Ctx, abilityId: string): Action[] | null {
  const top = s.chain[s.chain.length - 1];
  const a = ABILITIES.find((x) => x.id === abilityId);
  if (!top || top.opp || !a || a.speed < top.speed) return null;
  const found = a.find(s, ctx, top);
  if (!found) return null;
  return [
    ...found.cost,
    {
      type: 'CHAIN_PUSH',
      uid: found.uid,
      effect: -1,
      stepStart: 0,
      speed: a.speed,
      label: a.label,
      opp: a.id,
      targetLink: s.chain.length - 1,
      target: found.target,
    },
  ];
}

/** カード名から、その手札誘発の妨害の種類 */
export function handTrapAbility(name: string): { id: string; label: string } | null {
  const a = HAND_TRAP_ABILITIES.find((x) => x.card === name && HAND_TRAP_NAMES.has(name));
  return a ? { id: a.id, label: a.label } : null;
}

/** チェーンの一番上に使える妨害の一覧（CPU戦でプレイヤーが選ぶ）。uid は使うカード */
export function oppAbilityChoices(s: GameState, ctx: Ctx): { id: string; label: string; uid: string }[] {
  const top = s.chain[s.chain.length - 1];
  if (!top || top.opp) return [];
  const out: { id: string; label: string; uid: string }[] = [];
  for (const a of ABILITIES) {
    if (a.speed < top.speed) continue;
    const found = a.find(s, ctx, top);
    if (found) out.push({ id: a.id, label: a.label, uid: found.uid });
  }
  return out;
}
