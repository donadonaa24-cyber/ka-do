import { type Action, type Ctx, findLocation, getDef, oppMonsterSlots } from './game';
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
