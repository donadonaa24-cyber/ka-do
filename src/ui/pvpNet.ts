import type { PvpEntry, PvpPlayer, PvpRequest, Slot } from '../engine/pvp';

// 通信対戦の通信：公開ページの共有データ（db）に、部屋の情報・お互いの操作の記録・相手への応答を書く。
//   duels/<部屋コード>                 部屋（1P・2Pのデッキ、先攻）
//   duels/<部屋コード>/log<0|1>/c<n>   操作の記録（100手ずつ）
//   duels/<部屋コード>/req/s<0|1>      相手への応答（最新20件）

export interface RoomPlayer extends PvpPlayer {
  /** 作ったページの版（違うと再生がずれることがある） */
  build: string;
}

export interface RoomMeta {
  host: RoomPlayer;
  guest?: RoomPlayer;
  /** 1P（部屋を作った人）が先攻か */
  hostFirst: boolean;
  createdAt: number;
}

type Unsubscribe = () => void;
interface DocSnap {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface DocRef {
  get(): Promise<DocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
  onSnapshot(next: (snap: DocSnap) => void, error?: (e: unknown) => void): Unsubscribe;
}
interface CollRef {
  onSnapshot(next: (snap: { docs: DocSnap[] }) => void, error?: (e: unknown) => void): Unsubscribe;
  get(): Promise<{ docs: DocSnap[] }>;
}
export interface Db {
  doc(path: string): DocRef;
  collection(path: string): CollRef;
}

const CHUNK = 100;
const chunkId = (n: number) => `c${String(n).padStart(4, '0')}`;

/** 公開ページの共有データを使えるか（使えなければ null） */
export async function openDb(): Promise<Db | null> {
  const claude = (window as unknown as { claude?: { use(name: string): Promise<unknown> } }).claude;
  if (!claude?.use) return null;
  try {
    return ((await claude.use('db')) as Db | null) ?? null;
  } catch {
    return null;
  }
}

export function newRoomCode(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class PvpNet {
  private queue: Promise<void> = Promise.resolve();
  /** 書き込み済みの自分の記録の手数 */
  private written = 0;

  constructor(
    private readonly db: Db,
    readonly code: string,
  ) {}

  private room() {
    return this.db.doc(`duels/${this.code}`);
  }

  async createRoom(meta: RoomMeta): Promise<void> {
    await this.room().set(meta as unknown as Record<string, unknown>);
  }

  async getRoom(): Promise<RoomMeta | null> {
    const snap = await this.room().get();
    return snap.exists ? (snap.data() as unknown as RoomMeta) : null;
  }

  async joinRoom(meta: RoomMeta, guest: RoomPlayer): Promise<RoomMeta> {
    const next = { ...meta, guest };
    await this.room().set(next as unknown as Record<string, unknown>);
    return next;
  }

  watchRoom(cb: (meta: RoomMeta | null) => void, onError: (e: unknown) => void): Unsubscribe {
    return this.room().onSnapshot((s) => cb(s.exists ? (s.data() as unknown as RoomMeta) : null), onError);
  }

  /** プレイヤーの記録を見る（全部つなげて渡す） */
  watchLog(slot: Slot, cb: (entries: PvpEntry[]) => void, onError: (e: unknown) => void): Unsubscribe {
    return this.db.collection(`duels/${this.code}/log${slot}`).onSnapshot((snap) => {
      const docs = [...snap.docs].filter((d) => d.exists).sort((a, b) => a.id.localeCompare(b.id));
      cb(docs.flatMap((d) => (d.data()?.entries as PvpEntry[] | undefined) ?? []));
    }, onError);
  }

  async readLog(slot: Slot): Promise<PvpEntry[]> {
    const snap = await this.db.collection(`duels/${this.code}/log${slot}`).get();
    const docs = [...snap.docs].filter((d) => d.exists).sort((a, b) => a.id.localeCompare(b.id));
    return docs.flatMap((d) => (d.data()?.entries as PvpEntry[] | undefined) ?? []);
  }

  /** 自分の記録を書く（前回書いた続きから。同じドキュメントへの書き込みは1つずつ） */
  writeLog(slot: Slot, log: readonly PvpEntry[], already = this.written): Promise<void> {
    this.written = Math.max(this.written, already);
    const run = async () => {
      while (this.written < log.length) {
        const from = this.written;
        const n = Math.floor(from / CHUNK);
        const end = Math.min(log.length, (n + 1) * CHUNK);
        await this.db.doc(`duels/${this.code}/log${slot}/${chunkId(n)}`).set({ entries: log.slice(n * CHUNK, end) });
        this.written = end;
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  watchRequests(slot: Slot, cb: (reqs: PvpRequest[]) => void, onError: (e: unknown) => void): Unsubscribe {
    return this.db
      .doc(`duels/${this.code}/req/s${slot}`)
      .onSnapshot((s) => cb((s.data()?.list as PvpRequest[] | undefined) ?? []), onError);
  }

  /** 相手への応答を送る（最新20件を残す） */
  sendRequests(slot: Slot, list: PvpRequest[]): Promise<void> {
    const run = () => this.db.doc(`duels/${this.code}/req/s${slot}`).set({ list: list.slice(-20) });
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}
