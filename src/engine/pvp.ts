import { syncAction } from './cpu';
import { type Action, applyAction, createGame, type Ctx, findLocation, getDef } from './game';
import { DRAW_HAND_TRAPS, forceOppResponse, oppAbilityChoices } from './oppAI';
import type { DeckList, GameState, Location } from './types';

// 通信対戦：お互いが自分のゲームを持ち、操作の記録（PvpEntry）だけを送り合う。
// 相手のゲームは、相手の記録を再生して作る（同じ操作を同じ順に適用すれば必ず同じ盤面になる）。
// 相手の盤面は、自分のゲームに相手のカードとして写す（OPP_SYNC）。写す操作は大きいので、
// 記録には「相手のゲームの何手目の盤面を写したか」（SYNC_REF）だけを残し、再生する側で作り直す。

export type Slot = 0 | 1;
export type PvpEntry = Action | { type: 'SYNC_REF'; seq: number };

export interface PvpPlayer {
  deckName: string;
  deck: DeckList;
  seed: number;
  /** 初手に必ず含めるカード（テスト用） */
  fixedHand?: string[];
}

export interface PvpSetup {
  players: [PvpPlayer, PvpPlayer];
  /** 先攻のプレイヤー */
  first: Slot;
}

/** 通信対戦のルール：相手の妨害は相手が選ぶ（自動では使わない）。相手が使えるなら応答を待つ */
export const pvpCtx = (ctx: Ctx): Ctx => ({ ...ctx, options: { strict: true, oppAI: false, oppAsk: true } });

export const other = (p: Slot): Slot => (p === 0 ? 1 : 0);

export function initialGame(setup: PvpSetup, p: Slot, ctx: Ctx): GameState {
  return createGame(setup.players[p].deck, ctx, setup.players[p].seed, setup.players[p].fixedHand ?? []);
}

/** 記録の最初の操作：後攻は相手ターン（妨害だけできる状態）から始める */
export function openingEntries(setup: PvpSetup, p: Slot): PvpEntry[] {
  return p === setup.first ? [] : [{ type: 'END_TURN', toOpponent: true }];
}

type SyncAction = Extract<Action, { type: 'OPP_SYNC' }>;

/** お互いの記録を再生して、両方のゲームを作る */
export class PvpReplay {
  readonly games: [GameState, GameState];
  readonly counts: [number, number] = [0, 0];
  /** 記録しておくプレイヤーの、ゲームの操作にした記録（再読み込みで画面の記録を作り直すため） */
  readonly resolved: Action[] = [];
  /** syncs[p].get(k)：プレイヤー p のゲームの k 手目の後の盤面を写す操作 */
  private readonly syncs: [Map<number, SyncAction>, Map<number, SyncAction>] = [new Map(), new Map()];

  readonly ctx: Ctx;

  constructor(
    readonly setup: PvpSetup,
    ctx: Ctx,
    private readonly record: Slot | null = null,
  ) {
    // 相手の記録は相手の端末でルールチェック済み。再生は画面と同じくルールチェックなしで行う
    this.ctx = { ...ctx, options: { ...ctx.options, strict: false } };
    ctx = this.ctx;
    this.games = [initialGame(setup, 0, ctx), initialGame(setup, 1, ctx)];
    for (const p of [0, 1] as const) this.syncs[p].set(0, syncAction(this.games[p]) as SyncAction);
  }

  /** プレイヤー p のゲームの seq 手目の盤面を写す操作 */
  syncOf(p: Slot, seq: number): SyncAction | undefined {
    return this.syncs[p].get(seq);
  }

  /** プレイヤー p の記録の1手を、ゲームの操作にする（相手の盤面がまだ無ければ null） */
  resolve(p: Slot, e: PvpEntry): Action | null {
    if (e.type !== 'SYNC_REF') return e;
    return this.syncs[other(p)].get(e.seq) ?? null;
  }

  /** 新しく届いた記録を進められるところまで再生する。再生できない手があればエラー文 */
  ingest(logs: readonly [readonly PvpEntry[], readonly PvpEntry[]]): string | null {
    for (let progress = true; progress; ) {
      progress = false;
      for (const p of [0, 1] as const) {
        while (this.counts[p] < logs[p].length) {
          const e = logs[p][this.counts[p]];
          const a = this.resolve(p, e);
          if (!a) break;
          const r = applyAction(this.games[p], a, this.ctx);
          if (!r.ok) return `${p === 0 ? '1P' : '2P'}の${this.counts[p] + 1}手目を再生できません：${r.error}`;
          this.games[p] = r.state;
          this.counts[p]++;
          if (p === this.record) this.resolved.push(a);
          this.syncs[p].set(this.counts[p], syncAction(r.state) as SyncAction);
          // 相手が写した盤面より前のものはもう使わない
          if (e.type === 'SYNC_REF')
            for (const k of this.syncs[other(p)].keys()) if (k < e.seq) this.syncs[other(p)].delete(k);
          progress = true;
        }
      }
    }
    return null;
  }
}

/** 記録の中で最後に写した相手の盤面（何手目か） */
export function lastSyncRef(log: readonly PvpEntry[]): number | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.type === 'SYNC_REF') return e.seq;
  }
  return null;
}

/** 終えた自分のターンの数（後攻の最初の「相手ターンへ」は数えない） */
function turnsEnded(log: readonly PvpEntry[], second: boolean): number {
  const n = log.filter((e) => e.type === 'END_TURN' && e.toOpponent).length;
  return second ? Math.max(0, n - 1) : n;
}

/** 今ターンを進めているプレイヤー */
export function turnPlayer(setup: PvpSetup, logs: readonly [readonly PvpEntry[], readonly PvpEntry[]]): Slot {
  const f = setup.first;
  const s = other(f);
  return turnsEnded(logs[f], false) > turnsEnded(logs[s], true) ? s : f;
}

const category = (zone: string | undefined) =>
  !zone
    ? null
    : ['mz', 'emz', 'stz', 'fz', 'omz', 'oemz', 'ostz', 'ofz'].includes(zone)
      ? 'field'
      : zone.replace(/^o/, '');

/** 相手の盤面の場所を、カードの持ち主から見た場所にする */
function ownZone(loc: Location): Location | null {
  if (loc.zone === 'omz') return { zone: 'mz', index: loc.index };
  if (loc.zone === 'oemz') return { zone: 'emz', index: 1 - loc.index };
  if (loc.zone === 'ostz') return { zone: 'stz', index: loc.index };
  if (loc.zone === 'ofz') return { zone: 'fz' };
  return null;
}

/**
 * 相手のゲームで動いた自分のカード・LPを、自分のゲームに反映する操作と、相手の盤面を写し直す操作。
 * 相手が最後に写した自分の盤面と比べて、相手のゲームで変わったものだけを反映する（写した後に自分で動かしたものは戻さない）
 */
export function pvpReactions(
  replay: PvpReplay,
  me: Slot,
  logs: readonly [readonly PvpEntry[], readonly PvpEntry[]],
): PvpEntry[] {
  const them = other(me);
  const mine = replay.games[me];
  const theirs = replay.games[them];
  const out: PvpEntry[] = [];
  const seen = lastSyncRef(logs[them]);
  const saw = seen === null ? undefined : replay.syncOf(me, seen);
  if (saw) {
    const copies = new Map<string, string>();
    for (const [u, inst] of Object.entries(theirs.cards)) if (inst.opp && inst.syncKey) copies.set(inst.syncKey, u);
    for (const c of saw.cards) {
      const copy = copies.get(c.key);
      if (!copy || !mine.cards[c.key]) continue;
      const tLoc = findLocation(theirs, copy);
      const tCat = category(tLoc?.zone);
      const sawCat = category(c.zone);
      const myLoc = findLocation(mine, c.key);
      const myCat = category(myLoc?.zone);
      if (!tLoc || !tCat) continue;
      const inst = theirs.cards[copy];
      if (tCat !== sawCat && tCat !== myCat) {
        if (tCat === 'gy' || tCat === 'banished' || tCat === 'hand' || tCat === 'deck')
          out.push({ type: 'MOVE', uid: c.key, to: { zone: tCat }, reason: '相手の効果' });
        else if (tCat === 'field' && inst.banishAtEnd) {
          // ＰＳＹフレームギアの効果で特殊召喚されたカード
          const to = ownZone(tLoc);
          if (to)
            out.push(
              { type: 'MOVE', uid: c.key, to, faceUp: true, position: inst.position, reason: '効果で特殊召喚' },
              { type: 'BANISH_AT_END', uid: c.key },
            );
        }
      } else if (
        tCat === 'field' &&
        sawCat === 'field' &&
        myCat === 'field' &&
        inst.faceUp !== c.faceUp &&
        mine.cards[c.key].faceUp === c.faceUp
      ) {
        out.push({ type: 'MOVE', uid: c.key, to: myLoc!, faceUp: inst.faceUp, position: mine.cards[c.key].position });
      }
    }
    // 相手のゲームで受けたダメージ
    if (saw.lp !== undefined && theirs.opponentLp !== saw.lp && mine.lp !== theirs.opponentLp)
      out.push({ type: 'LP_SET', lp: theirs.opponentLp, reason: '相手のターンの効果・戦闘' });
  }
  // 相手の盤面が変わっていれば写し直す
  const theirSeq = replay.counts[them];
  const synced = lastSyncRef(logs[me]);
  if (synced !== theirSeq) {
    const now = replay.syncOf(them, theirSeq);
    const before = synced === null ? undefined : replay.syncOf(them, synced);
    if (now && JSON.stringify(now) !== JSON.stringify(before)) out.push({ type: 'SYNC_REF', seq: theirSeq });
  }
  // 相手がターンを終えたら、自分のターンを始める（ドローフェイズ）
  if (mine.opponentTurn && !mine.chain.length && turnPlayer(replay.setup, logs) === me) out.push({ type: 'END_TURN' });
  return out;
}

/** 相手の効果の発動などに、自分が使える妨害・手札誘発 */
export interface PvpOption {
  kind: 'chain' | 'draw' | 'droll';
  /** 自分のゲームでのカード */
  uid: string;
  name: string;
  label: string;
  abilityId?: string;
}

/** 相手のチェーンの一番上が、自分の応答を待っているか */
export function waitingForMe(theirs: GameState): boolean {
  const top = theirs.chain[theirs.chain.length - 1];
  return !!top && !top.opp && !top.oppPassed;
}

export function pvpResponseOptions(replay: PvpReplay, me: Slot, ctx: Ctx, usedNames: readonly string[]): PvpOption[] {
  const mine = replay.games[me];
  const theirs = replay.games[other(me)];
  const out: PvpOption[] = [];
  if (!theirs.opp) return out;
  const nameOf = (u: string) => getDef(mine, ctx, u).name;
  if (waitingForMe(theirs)) {
    const seen = new Set<string>();
    for (const c of oppAbilityChoices(theirs, ctx)) {
      const uid = theirs.cards[c.uid]?.syncKey;
      if (!uid || !mine.cards[uid] || seen.has(`${c.id}:${nameOf(uid)}`)) continue;
      seen.add(`${c.id}:${nameOf(uid)}`);
      out.push({ kind: 'chain', uid, name: nameOf(uid), label: c.label, abilityId: c.id });
    }
    const myField = [...mine.mz, ...mine.emz, ...mine.stz, mine.fz].some(Boolean);
    for (const uid of mine.hand) {
      const n = nameOf(uid);
      if (!DRAW_HAND_TRAPS.includes(n) || usedNames.includes(n) || out.some((o) => o.name === n)) continue;
      if (n === 'マルチャミー・フワロス' && myField) continue;
      out.push({ kind: 'draw', uid, name: n, label: '相手が特殊召喚するたびに1枚ドロー', abilityId: undefined });
    }
  }
  // ドロール＆ロックバード：相手がドロー以外でデッキから手札に加えた後
  if (!theirs.chain.length && theirs.deckToHandTurn === theirs.turn && theirs.noDeckToHandTurn !== theirs.turn) {
    const droll = mine.hand.find((u) => nameOf(u) === 'ドロール＆ロックバード');
    if (droll && !usedNames.includes('ドロール＆ロックバード'))
      out.push({
        kind: 'droll',
        uid: droll,
        name: 'ドロール＆ロックバード',
        label: 'このターン、お互いにデッキからカードを手札に加えられなくする',
      });
  }
  return out;
}

/** 相手への応答（相手のゲームで行ってもらう） */
export interface PvpRequest {
  id: number;
  kind: 'chain' | 'pass' | 'droll';
  /** 応答したチェーンの長さと一番上のカード（ずれていたら使わない） */
  link: number;
  top: string;
  abilityId?: string;
  name?: string;
}

export function makeRequest(theirs: GameState, id: number, kind: PvpRequest['kind'], option?: PvpOption): PvpRequest {
  const top = theirs.chain[theirs.chain.length - 1];
  return {
    id,
    kind,
    link: theirs.chain.length,
    top: top?.uid ?? '',
    ...(option?.abilityId ? { abilityId: option.abilityId } : {}),
    ...(option ? { name: option.name } : {}),
  };
}

/** 相手からの応答を、自分のゲームの操作にする（もう合わない応答は null） */
export function applyRequest(game: GameState, ctx: Ctx, req: PvpRequest): Action | null {
  if (req.kind === 'droll')
    return game.noDeckToHandTurn === game.turn ? null : { type: 'NO_DECK_TO_HAND', by: '相手のドロール＆ロックバード' };
  const top = game.chain[game.chain.length - 1];
  if (!top || top.opp || top.oppPassed || game.chain.length !== req.link || top.uid !== req.top) return null;
  if (req.kind === 'pass') return { type: 'OPP_PASS' };
  const resp = req.abilityId ? forceOppResponse(game, ctx, req.abilityId) : null;
  if (!resp) return { type: 'OPP_PASS' };
  return { type: 'BATCH', label: `相手の${req.name ?? '妨害'}`, actions: [{ type: 'OPP_PASS' }, ...resp] };
}
