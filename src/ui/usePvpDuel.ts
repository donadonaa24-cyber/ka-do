import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { specialSummonsBetween } from '../engine/cpu';
import type { Action, Ctx } from '../engine/game';
import { oppCanRespond } from '../engine/oppAI';
import {
  applyRequest,
  makeRequest,
  openingEntries,
  other,
  type PvpEntry,
  type PvpOption,
  PvpReplay,
  pvpCtx,
  pvpReactions,
  type PvpRequest,
  pvpResponseOptions,
  type PvpSetup,
  type Slot,
  turnPlayer,
  waitingForMe,
} from '../engine/pvp';
import { randomSeed } from '../engine/rng';
import type { DeckList, GameState } from '../engine/types';
import { newRoomCode, openDb, PvpNet, type RoomMeta, type RoomPlayer } from './pvpNet';
import type { SessionData } from './session';

import { PVP_ENABLED } from './features';

const KEY = 'ygo-solo:pvp';

/** 端末に残す通信対戦の状態（再読み込みで続きから） */
interface Saved {
  code: string;
  slot: Slot;
  setup?: PvpSetup;
  myLog: PvpEntry[];
  /** 処理した相手の応答の番号 */
  processed: number;
  /** 送った応答 */
  sent: PvpRequest[];
  /** このターンに使った手札誘発（増殖するＧなど） */
  used: string[];
  /** 増殖するＧなどで、相手が特殊召喚するたびに引く枚数 */
  drawPer: number;
  /** used・drawPer を数え始めたターン */
  turnKey: number;
}

function load(): Saved | null {
  // 通信対戦を公開するまでは、保存された対戦も読まない
  if (!PVP_ENABLED) return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function save(s: Saved | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // 保存できなくても対戦は続けられる
  }
}

/** 通信対戦を続けているか（ページを開いた時に判定する） */
export const hasSavedPvp = () => !!load()?.setup;

export interface PvpView {
  code: string;
  slot: Slot;
  /** 相手の参加を待っている */
  waiting: boolean;
  /** 自分のターンか */
  myTurn: boolean;
  first: boolean;
  opponentDeck?: string;
  /** 相手の効果に使える手札誘発など */
  options: PvpOption[];
  /** 相手の効果の発動を待っている（応答を返していない） */
  askMe: boolean;
  /** 自分のチェーンへの相手の応答を待っている */
  waitingOpp: boolean;
  /** 相手のゲームの最近の出来事 */
  recent: string[];
  theirs: GameState | null;
  connected: boolean;
}

interface Opts {
  ctx: Ctx;
  decks: DeckList[];
  dispatch: (action: Action, entry?: PvpEntry) => boolean;
  /** 自分のゲームを作り直す */
  startSession: (s: SessionData) => void;
  onError: (msg: string) => void;
  onActive: (on: boolean) => void;
  /** 画面の記録の手数 */
  sessionCount: number;
}

export function usePvpDuel(opts: Opts) {
  const { dispatch, onError } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const ctx = useMemo(() => pvpCtx(opts.ctx), [opts.ctx]);
  const [saved, setSaved] = useState<Saved | null>(() => load());
  const savedRef = useRef(saved);
  const [version, setVersion] = useState(0);
  const [theirLog, setTheirLog] = useState<PvpEntry[]>([]);
  const [requests, setRequests] = useState<PvpRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const netRef = useRef<PvpNet | null>(null);
  const replayRef = useRef<PvpReplay | null>(null);
  const prevTheirs = useRef<GameState | null>(null);

  const update = useCallback((patch: Partial<Saved> | null) => {
    const next = patch === null ? null : ({ ...savedRef.current!, ...patch } as Saved);
    savedRef.current = next;
    save(next);
    setSaved(next);
  }, []);

  const slot = saved?.slot ?? 0;
  const setup = saved?.setup;

  // 相手の記録が届いたら再生する
  const ingest = useCallback(() => {
    const r = replayRef.current;
    const s = savedRef.current;
    if (!r || !s) return;
    const logs: [PvpEntry[], PvpEntry[]] =
      s.slot === 0 ? [s.myLog, theirLogRef.current] : [theirLogRef.current, s.myLog];
    const err = r.ingest(logs);
    if (err) onError(`通信対戦：${err}`);
    setVersion((v) => v + 1);
  }, [onError]);
  const theirLogRef = useRef<PvpEntry[]>([]);

  /** 自分の操作（App の dispatch から呼ぶ） */
  const onLocal = useCallback(
    (entry: PvpEntry) => {
      const s = savedRef.current;
      if (!s?.setup) return;
      const myLog = [...s.myLog, entry];
      update({ myLog });
      netRef.current?.writeLog(s.slot, myLog).catch(() => onError('通信対戦：記録を送れませんでした'));
      ingest();
    },
    [update, ingest, onError],
  );

  // 部屋・記録・応答を見る
  useEffect(() => {
    if (!saved?.code) return;
    let alive = true;
    const unsubs: (() => void)[] = [];
    (async () => {
      const db = await openDb();
      if (!alive) return;
      if (!db) {
        onError('通信対戦はclaude.aiで公開したページでのみ使えます');
        return;
      }
      const net = new PvpNet(db, saved.code);
      netRef.current = net;
      const me = saved.slot;
      // 自分の記録：別の端末で進めていた分があれば使う。書けていない分は書く
      const remote = await net.readLog(me).catch(() => [] as PvpEntry[]);
      if (!alive) return;
      const s = savedRef.current!;
      if (remote.length > s.myLog.length) update({ myLog: remote });
      net.writeLog(me, savedRef.current!.myLog, Math.min(remote.length, savedRef.current!.myLog.length));
      setConnected(true);
      unsubs.push(
        net.watchRoom(
          (meta) => {
            if (!meta || savedRef.current?.setup || !meta.guest) return;
            begin(meta, me);
          },
          () => setConnected(false),
        ),
        net.watchLog(
          other(me),
          (entries) => {
            if (entries.length < theirLogRef.current.length) return;
            theirLogRef.current = entries;
            setTheirLog(entries);
          },
          () => setConnected(false),
        ),
        net.watchRequests(other(me), setRequests, () => setConnected(false)),
      );
    })();
    return () => {
      alive = false;
      unsubs.forEach((u) => u());
      netRef.current = null;
    };
    // 部屋が決まった時だけ繋ぎ直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.code, saved?.slot]);

  /** 2人そろったら対戦を始める（自分のゲームを作る） */
  const begin = useCallback(
    (meta: RoomMeta, me: Slot) => {
      const st: PvpSetup = {
        players: [meta.host, meta.guest!],
        first: meta.hostFirst ? 0 : 1,
      };
      const myLog = openingEntries(st, me);
      update({ setup: st, myLog });
      const p = st.players[me];
      optsRef.current.startSession({
        deckName: p.deckName,
        seed: p.seed,
        fixedHand: [],
        handSize: 5,
        strict: true,
        actions: myLog.filter((e): e is Action => e.type !== 'SYNC_REF'),
      });
      netRef.current?.writeLog(me, myLog);
    },
    [update],
  );

  // 対戦の再生を用意する（再読み込みの後は、記録から自分のゲームを作り直す）
  useEffect(() => {
    if (!setup) {
      replayRef.current = null;
      return;
    }
    const r = new PvpReplay(setup, ctx, slot);
    replayRef.current = r;
    prevTheirs.current = null;
    const s = savedRef.current!;
    const logs: [PvpEntry[], PvpEntry[]] = slot === 0 ? [s.myLog, theirLogRef.current] : [theirLogRef.current, s.myLog];
    r.ingest(logs);
    optsRef.current.onActive(true);
    setVersion((v) => v + 1);
    // 対戦が決まった時だけ作る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, slot]);

  useEffect(() => {
    if (setup) ingest();
  }, [theirLog, setup, ingest]);

  const logs = (): [PvpEntry[], PvpEntry[]] => {
    const s = savedRef.current!;
    return s.slot === 0 ? [s.myLog, theirLogRef.current] : [theirLogRef.current, s.myLog];
  };

  // 相手の変化に反応する：相手の盤面を写す・相手のゲームで動いた自分のカードを動かす・ターンを始める・応答を処理する
  useEffect(() => {
    const r = replayRef.current;
    const s = savedRef.current;
    if (!r || !s?.setup || r.counts[s.slot] !== s.myLog.length) return;
    const me = s.slot;
    const theirs = r.games[other(me)];
    // ターンが変わったら、増殖するＧなどの記録を消す
    const key = countEnds(logs());
    if (key !== s.turnKey) {
      update({ turnKey: key, used: [], drawPer: 0 });
      return;
    }
    // 別の端末で進めた記録で始めた時などは、画面の記録を作り直す
    if (optsRef.current.sessionCount !== s.myLog.length) {
      const p = s.setup.players[me];
      optsRef.current.startSession({
        deckName: p.deckName,
        seed: p.seed,
        fixedHand: [],
        handSize: 5,
        strict: true,
        actions: [...r.resolved],
      });
      return;
    }
    // 増殖するＧ：相手が特殊召喚した数だけドロー
    const prev = prevTheirs.current;
    prevTheirs.current = theirs;
    if (prev && prev !== theirs && s.drawPer) {
      const n = specialSummonsBetween(prev, theirs);
      if (n) {
        dispatch({ type: 'DRAW', count: n * s.drawPer });
        return;
      }
    }
    const entries = pvpReactions(r, me, logs());
    for (const e of entries) {
      const a = r.resolve(me, e);
      if (!a || !dispatch(a, e)) {
        onError('通信対戦：相手の動きを反映できませんでした');
        return;
      }
    }
    if (entries.length) return;
    // 相手からの応答（自分のチェーンへの妨害・パス・ドロール）
    for (const req of requests) {
      if (req.id <= s.processed) continue;
      update({ processed: req.id });
      const a = applyRequest(r.games[me], ctx, req);
      if (a) dispatch(a);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, requests, saved, opts.sessionCount]);

  const r = replayRef.current;
  const me = slot;
  const theirs = r && setup ? r.games[other(me)] : null;
  const mine = r && setup ? r.games[me] : null;
  const sent = saved?.sent ?? [];
  const lastSent = sent[sent.length - 1];
  const linkKey = theirs ? `${theirs.chain.length}:${theirs.chain[theirs.chain.length - 1]?.uid ?? ''}` : '';
  const answered = !!lastSent && `${lastSent.link}:${lastSent.top}` === linkKey && lastSent.kind !== 'droll';
  const options = r && setup && saved && !answered ? pvpResponseOptions(r, me, ctx, saved.used) : ([] as PvpOption[]);
  const askMe = !!theirs && waitingForMe(theirs) && !answered && options.some((o) => o.kind !== 'droll');
  const waitingOpp = !!mine && oppCanRespond(mine, ctx);

  const send = useCallback(
    (kind: PvpRequest['kind'], option?: PvpOption) => {
      const s = savedRef.current;
      const r2 = replayRef.current;
      if (!s?.setup || !r2) return;
      const req = makeRequest(r2.games[other(s.slot)], (s.sent[s.sent.length - 1]?.id ?? 0) + 1, kind, option);
      const list = [...s.sent, req].slice(-20);
      update({ sent: list });
      netRef.current?.sendRequests(s.slot, list).catch(() => onError('通信対戦：応答を送れませんでした'));
    },
    [update, onError],
  );

  /** 相手の効果に応答する（null は使わない） */
  const respond = useCallback(
    (o: PvpOption | null) => {
      const s = savedRef.current;
      if (!s) return;
      if (!o) return send('pass');
      if (o.kind === 'chain') return send('chain', o);
      dispatch({ type: 'MOVE', uid: o.uid, to: { zone: 'gy' }, reason: `${o.name}を発動（相手の効果に対して）` });
      if (o.kind === 'draw') update({ used: [...s.used, o.name], drawPer: s.drawPer + 1 });
      else {
        update({ used: [...s.used, o.name] });
        send('droll', o);
      }
    },
    [send, dispatch, update],
  );

  /** 部屋を作る */
  const host = useCallback(
    async (deckName: string, hostFirst: boolean): Promise<string | null> => {
      if (!PVP_ENABLED) return null;
      const db = await openDb();
      if (!db) {
        onError('通信対戦はclaude.aiで公開したページでのみ使えます');
        return null;
      }
      const deck = opts.decks.find((d) => d.name === deckName);
      if (!deck) return null;
      const code = newRoomCode();
      const net = new PvpNet(db, code);
      const meta: RoomMeta = { host: player(deckName, deck), hostFirst, createdAt: Date.now() };
      try {
        await net.createRoom(meta);
      } catch {
        onError('部屋を作れませんでした（このページを編集できる権限が必要です）');
        return null;
      }
      update(null);
      const s: Saved = { code, slot: 0, myLog: [], processed: 0, sent: [], used: [], drawPer: 0, turnKey: 0 };
      savedRef.current = s;
      save(s);
      setSaved(s);
      return code;
    },
    [opts.decks, onError, update],
  );

  /** 部屋に入る */
  const join = useCallback(
    async (code: string, deckName: string): Promise<boolean> => {
      if (!PVP_ENABLED) return false;
      const db = await openDb();
      if (!db) {
        onError('通信対戦はclaude.aiで公開したページでのみ使えます');
        return false;
      }
      const deck = opts.decks.find((d) => d.name === deckName);
      const net = new PvpNet(db, code.trim().toLowerCase());
      const meta = await net.getRoom().catch(() => null);
      if (!meta || !deck) {
        onError('部屋が見つかりません。部屋コードを確かめてください');
        return false;
      }
      if (meta.guest) {
        onError('この部屋はもう対戦が始まっています');
        return false;
      }
      try {
        await net.joinRoom(meta, player(deckName, deck));
      } catch {
        onError('部屋に入れませんでした（このページを編集できる権限が必要です）');
        return false;
      }
      const s: Saved = {
        code: net.code,
        slot: 1,
        myLog: [],
        processed: 0,
        sent: [],
        used: [],
        drawPer: 0,
        turnKey: 0,
      };
      savedRef.current = s;
      save(s);
      setSaved(s);
      return true;
    },
    [opts.decks, onError],
  );

  const stop = useCallback(() => {
    update(null);
    theirLogRef.current = [];
    setTheirLog([]);
    replayRef.current = null;
    optsRef.current.onActive(false);
  }, [update]);

  const view: PvpView | null = saved
    ? {
        code: saved.code,
        slot: saved.slot,
        waiting: !saved.setup,
        myTurn: !!setup && turnPlayer(setup, logsOf(saved, theirLog)) === saved.slot,
        first: !!setup && setup.first === saved.slot,
        opponentDeck: setup?.players[other(saved.slot)].deckName,
        options,
        askMe,
        waitingOpp,
        recent: theirs ? recentLines(theirs) : [],
        theirs,
        connected,
      }
    : null;
  void version;
  return { pvp: view, onLocal, respond, host, join, stop, skipWait: () => dispatch({ type: 'OPP_PASS' }) };
}

function player(deckName: string, deck: DeckList): RoomPlayer {
  return {
    deckName,
    deck: { name: deck.name, main: deck.main, extra: deck.extra },
    seed: randomSeed(),
    build: __BUILD_TIME__,
  };
}

function logsOf(s: Saved, theirLog: PvpEntry[]): [PvpEntry[], PvpEntry[]] {
  return s.slot === 0 ? [s.myLog, theirLog] : [theirLog, s.myLog];
}

/** 終えたターンの数（ターンが変わったかの目印） */
function countEnds(logs: [PvpEntry[], PvpEntry[]]): number {
  return logs[0].concat(logs[1]).filter((e) => e.type === 'END_TURN').length;
}

/** 相手のゲームのログを、こちらから見た言い方で */
function recentLines(theirs: GameState): string[] {
  return theirs.log
    .slice(-6)
    .map((l) => l.text)
    .filter((t) => !t.startsWith('（練習）'))
    .map((t) =>
      t
        .replace(/相手の/g, '__')
        .replace(/自分の/g, '相手の')
        .replace(/__/g, 'あなたの'),
    );
}
