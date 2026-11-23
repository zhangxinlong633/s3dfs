import net from 'node:net';
import type { DLevelDB } from './kv.js';
import type { ChordTransport, KVValue, ScanOptions, ScanResult, VnodeInfo } from './types.js';
import { DLevelDBError, type DLevelDBErrorCode } from './types.js';

/** 对外公布的地址是 HTTP 端口。节点之间的 Chord 和复制用下一个端口上的长连接。 */
export function linkAddress(address: string): { host: string; port: number } {
  const cut = address.lastIndexOf(':');
  const host = cut === -1 ? address : address.slice(0, cut);
  const port = cut === -1 ? 9801 : Number(address.slice(cut + 1)) + 1;
  return { host, port };
}

type FrameHeader = {
  id: number;
  op?: string;
  ok?: boolean;
  code?: string;
  message?: string;
  json?: unknown;
  hash?: string;
  hops?: number;
  vnode?: VnodeInfo;
  target?: string;
  vnodeId?: string;
  mtimeMs?: number;
  vnodes?: VnodeInfo[];
  key?: string;
  opts?: ScanOptions;
  vnodeIds?: string[];
};

function encodeFrame(header: FrameHeader, payload: Buffer = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const out = Buffer.alloc(8 + json.length + payload.length);
  out.writeUInt32BE(json.length, 0);
  out.writeUInt32BE(payload.length, 4);
  json.copy(out, 8);
  if (payload.length > 0) {
    payload.copy(out, 8 + json.length);
  }
  return out;
}

function takeFrame(buf: Buffer): { header: FrameHeader; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 8) {
    return null;
  }
  const jsonLen = buf.readUInt32BE(0);
  const payloadLen = buf.readUInt32BE(4);
  if (jsonLen > 8 * 1024 * 1024 || payloadLen > 64 * 1024 * 1024) {
    throw new DLevelDBError('BAD_REQUEST', 'link frame too large');
  }
  const total = 8 + jsonLen + payloadLen;
  if (buf.length < total) {
    return null;
  }
  const header = JSON.parse(buf.subarray(8, 8 + jsonLen).toString('utf8')) as FrameHeader;
  const payload = Buffer.from(buf.subarray(8 + jsonLen, total));
  return { header, payload, rest: buf.subarray(total) };
}

class PeerConn {
  private socket: net.Socket | undefined;
  private buf: Buffer = Buffer.alloc(0);
  private connecting: Promise<void> | undefined;
  private nextId = 1;
  private readonly waiters = new Map<
    number,
    { ok: (value: { json: unknown; payload: Buffer }) => void; fail: (err: Error) => void }
  >();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.destroy();
    this.failAll();
  }

  private failAll(): void {
    const waiters = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of waiters) {
      try {
        waiter.fail(new DLevelDBError('PRIMARY_UNAVAILABLE', 'link closed'));
      } catch {
        // 调用方已经结束。
      }
    }
  }

  async call(header: Omit<FrameHeader, 'id'>, payload: Buffer | undefined, timeoutMs: number): Promise<{ json: unknown; payload: Buffer }> {
    await this.ensure();
    const id = this.nextId++;
    const frame = encodeFrame({ ...header, id }, payload ?? Buffer.alloc(0));
    const pending = new Promise<{ json: unknown; payload: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new DLevelDBError('TIMEOUT', `link timeout ${header.op} @ ${this.host}:${this.port}`));
      }, timeoutMs);
      this.waiters.set(id, {
        ok: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        fail: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket?.write(frame);
    });
    // 周期任务没有等待方。挂一个空的处理，避免关闭连接时变成未接住的拒绝。
    pending.catch(() => undefined);
    return await pending;
  }

  private async ensure(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      const fail = (err: Error) => {
        socket.destroy();
        if (this.socket === socket) {
          this.socket = undefined;
        }
        reject(err);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.removeListener('error', fail);
        socket.setTimeout(0);
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        socket.on('data', (chunk) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        socket.on('error', () => this.drop());
        socket.on('close', () => this.drop());
        resolve();
      });
      socket.setTimeout(this.timeoutMs, () => {
        fail(new DLevelDBError('TIMEOUT', `link connect timeout ${this.host}:${this.port}`));
      });
    });
  }

  private drop(): void {
    this.socket = undefined;
    this.failAll();
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = takeFrame(this.buf);
      if (!frame) {
        return;
      }
      this.buf = Buffer.from(frame.rest);
      const waiter = this.waiters.get(frame.header.id);
      if (!waiter) {
        continue;
      }
      this.waiters.delete(frame.header.id);
      if (frame.header.ok === false) {
        const code = (frame.header.code ?? 'PRIMARY_UNAVAILABLE') as DLevelDBErrorCode;
        waiter.fail(new DLevelDBError(code, frame.header.message ?? 'link call failed'));
      } else {
        waiter.ok({ json: frame.header.json, payload: frame.payload });
      }
    }
  }
}

function metaOf(value: { size: number; crc: number; mtimeMs: number }): { size: number; crc: number; mtimeMs: number } {
  return { size: value.size, crc: value.crc, mtimeMs: value.mtimeMs };
}

async function dispatch(db: DLevelDB, header: FrameHeader, payload: Buffer): Promise<{ json: unknown; payload: Buffer }> {
  switch (header.op) {
    case 'ping':
      return { json: { ok: true, nodeId: db.config.nodeId }, payload: Buffer.alloc(0) };
    case 'findSuccessor': {
      if (!header.hash) {
        throw new DLevelDBError('BAD_REQUEST', 'missing hash');
      }
      const vnode = await db.ring.findSuccessor(header.hash, header.hops ?? 0);
      return { json: { vnode }, payload: Buffer.alloc(0) };
    }
    case 'notify': {
      if (!header.vnode || !header.target) {
        throw new DLevelDBError('BAD_REQUEST', 'missing vnode or target');
      }
      db.ring.handleNotify(header.target, header.vnode);
      return { json: { ok: true }, payload: Buffer.alloc(0) };
    }
    case 'predecessor':
      return { json: { vnode: db.ring.handlePredecessor(header.vnodeId ?? '') }, payload: Buffer.alloc(0) };
    case 'successorList':
      return { json: { vnodes: db.ring.handleSuccessorList(header.vnodeId ?? '') }, payload: Buffer.alloc(0) };
    case 'announce':
      db.ring.rememberAll(header.vnodes ?? []);
      db.ring.formLocalRing();
      return { json: { vnodes: db.ring.sortedKnown() }, payload: Buffer.alloc(0) };
    case 'put': {
      if (!header.key) {
        throw new DLevelDBError('BAD_REQUEST', 'missing key');
      }
      const prefs = db.lookup(header.key).preference;
      const primary = prefs[0];
      if (!primary || !db.ownsPrimary(primary.id)) {
        throw new DLevelDBError('NOT_PRIMARY', `not primary for ${header.key}`);
      }
      await db.putAsPrimary(header.key, payload, prefs);
      return { json: { ok: true }, payload: Buffer.alloc(0) };
    }
    case 'failoverPut': {
      if (!header.key) {
        throw new DLevelDBError('BAD_REQUEST', 'missing key');
      }
      await db.putWhilePrimaryDown(header.key, payload, undefined, true);
      return { json: { ok: true }, payload: Buffer.alloc(0) };
    }
    case 'failoverDelete': {
      if (!header.key) {
        throw new DLevelDBError('BAD_REQUEST', 'missing key');
      }
      await db.deleteWhilePrimaryDown(header.key, undefined, true);
      return { json: { deleted: true }, payload: Buffer.alloc(0) };
    }
    case 'delete': {
      if (!header.key) {
        throw new DLevelDBError('BAD_REQUEST', 'missing key');
      }
      return { json: { deleted: await db.delete(header.key) }, payload: Buffer.alloc(0) };
    }
    case 'replicatePut': {
      if (!header.key || !header.vnodeId) {
        throw new DLevelDBError('BAD_REQUEST', 'missing key or vnode');
      }
      await db.replicateLocalPut(header.vnodeId, header.key, payload, header.mtimeMs);
      return { json: { ok: true }, payload: Buffer.alloc(0) };
    }
    case 'replicateDelete': {
      if (!header.key || !header.vnodeId) {
        throw new DLevelDBError('BAD_REQUEST', 'missing key or vnode');
      }
      return { json: { deleted: await db.replicateLocalDelete(header.vnodeId, header.key) }, payload: Buffer.alloc(0) };
    }
    case 'get':
    case 'head': {
      if (!header.key || !header.vnodeId) {
        throw new DLevelDBError('BAD_REQUEST', 'missing key or vnode');
      }
      const headOnly = header.op === 'head';
      if (db.ownsPrimary(header.vnodeId)) {
        const found = headOnly ? await db.localPrimaryHead(header.key, header.vnodeId) : await db.localPrimaryGet(header.key, header.vnodeId);
        if (!found) {
          return { json: { missing: true }, payload: Buffer.alloc(0) };
        }
        return headOnly
          ? { json: metaOf(found), payload: Buffer.alloc(0) }
          : { json: metaOf(found), payload: (found as KVValue).value };
      }
      const found = headOnly ? await db.localReplicaHead(header.key, header.vnodeId) : await db.localReplicaGet(header.key, header.vnodeId);
      if (!found) {
        return { json: { missing: true }, payload: Buffer.alloc(0) };
      }
      return headOnly
        ? { json: metaOf(found), payload: Buffer.alloc(0) }
        : { json: metaOf(found), payload: (found as KVValue).value };
    }
    case 'getAny':
    case 'headAny': {
      if (!header.key) {
        throw new DLevelDBError('BAD_REQUEST', 'missing key');
      }
      if (header.op === 'headAny') {
        const meta = await db.localAnyHead(header.key);
        return meta ? { json: metaOf(meta), payload: Buffer.alloc(0) } : { json: { missing: true }, payload: Buffer.alloc(0) };
      }
      const found = await db.localAnyGet(header.key);
      return found
        ? { json: metaOf(found), payload: found.value }
        : { json: { missing: true }, payload: Buffer.alloc(0) };
    }
    case 'scan':
      return { json: await db.scanLocalPrimaries(header.opts ?? {}), payload: Buffer.alloc(0) };
    case 'scanReplica':
      return { json: await db.scanLocalReplicas(header.vnodeIds ?? [], header.opts ?? {}), payload: Buffer.alloc(0) };
    default:
      throw new DLevelDBError('BAD_REQUEST', `unknown link op ${header.op ?? ''}`);
  }
}

export function listenLink(db: DLevelDB, address = db.config.advertiseAddr): Promise<net.Server> {
  const { port } = linkAddress(address);
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const pending: { header: FrameHeader; payload: Buffer }[] = [];
      try {
        for (;;) {
          const frame = takeFrame(buf);
          if (!frame) {
            break;
          }
          buf = Buffer.from(frame.rest);
          pending.push({ header: frame.header, payload: frame.payload });
        }
      } catch (err) {
        socket.destroy();
        return;
      }
      for (const frame of pending) {
        void dispatch(db, frame.header, frame.payload)
          .then((result) => {
            socket.write(encodeFrame({ id: frame.header.id, ok: true, json: result.json }, result.payload));
          })
          .catch((err: unknown) => {
            const code = err instanceof DLevelDBError ? err.code : 'BAD_REQUEST';
            const message = err instanceof Error ? err.message : String(err);
            socket.write(encodeFrame({ id: frame.header.id, ok: false, code, message }));
          });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

/** 每个对端一条长连接。Chord、复制和跨节点读写都走这里。 */
export class LinkTransport implements ChordTransport {
  private readonly peers = new Map<string, PeerConn>();

  constructor(
    readonly localAddress: string,
    readonly timeoutMs: number,
  ) {}

  close(): void {
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
  }

  private peer(address: string): PeerConn {
    let conn = this.peers.get(address);
    if (!conn) {
      const { host, port } = linkAddress(address);
      conn = new PeerConn(host, port, this.timeoutMs);
      this.peers.set(address, conn);
    }
    return conn;
  }

  private async jsonAt(address: string, op: string, header: Omit<FrameHeader, 'id' | 'op'>, payload?: Buffer): Promise<unknown> {
    const res = await this.peer(address).call({ op, ...header }, payload, this.timeoutMs);
    return res.json;
  }

  async findSuccessor(address: string, hash: string, hops = 0): Promise<VnodeInfo> {
    const body = (await this.jsonAt(address, 'findSuccessor', { hash, hops })) as { vnode: VnodeInfo };
    return body.vnode;
  }

  async notify(address: string, vnode: VnodeInfo, targetId: string): Promise<void> {
    await this.jsonAt(address, 'notify', { vnode, target: targetId });
  }

  async getPredecessor(address: string, vnodeId: string): Promise<VnodeInfo | null> {
    const body = (await this.jsonAt(address, 'predecessor', { vnodeId })) as { vnode: VnodeInfo | null };
    return body.vnode;
  }

  async getSuccessorList(address: string, vnodeId: string): Promise<VnodeInfo[]> {
    const body = (await this.jsonAt(address, 'successorList', { vnodeId })) as { vnodes?: VnodeInfo[] };
    return body.vnodes ?? [];
  }

  async ping(address: string): Promise<boolean> {
    try {
      await this.peer(address).call({ op: 'ping' }, undefined, Math.min(2000, this.timeoutMs));
      return true;
    } catch {
      return false;
    }
  }

  async announce(address: string, vnodes: VnodeInfo[]): Promise<VnodeInfo[]> {
    const body = (await this.jsonAt(address, 'announce', { vnodes })) as { vnodes?: VnodeInfo[] };
    return body.vnodes ?? [];
  }

  async proxyPut(address: string, key: string, value: Buffer): Promise<void> {
    await this.peer(address).call({ op: 'put', key }, value, Math.max(this.timeoutMs, 60_000));
  }

  async proxyFailoverPut(address: string, key: string, value: Buffer): Promise<void> {
    await this.peer(address).call({ op: 'failoverPut', key }, value, Math.max(this.timeoutMs, 60_000));
  }

  async proxyFailoverDelete(address: string, key: string): Promise<void> {
    await this.jsonAt(address, 'failoverDelete', { key });
  }

  async replicatePut(address: string, ownerVnodeId: string, key: string, value: Buffer, mtimeMs?: number): Promise<void> {
    await this.peer(address).call({ op: 'replicatePut', key, vnodeId: ownerVnodeId, mtimeMs }, value, Math.max(this.timeoutMs, 60_000));
  }

  async proxyDelete(address: string, key: string): Promise<boolean> {
    const body = (await this.jsonAt(address, 'delete', { key })) as { deleted?: boolean };
    return !!body.deleted;
  }

  async replicateDelete(address: string, ownerVnodeId: string, key: string): Promise<void> {
    await this.jsonAt(address, 'replicateDelete', { key, vnodeId: ownerVnodeId });
  }

  async proxyGet(address: string, key: string, vnodeId: string): Promise<KVValue | null> {
    return this.recvValue(address, 'get', key, vnodeId);
  }

  async proxyGetAny(address: string, key: string): Promise<KVValue | null> {
    return this.recvValue(address, 'getAny', key);
  }

  async proxyHead(address: string, key: string, vnodeId: string): Promise<Omit<KVValue, 'value'> | null> {
    return this.recvMeta(address, 'head', key, vnodeId);
  }

  async proxyHeadAny(address: string, key: string): Promise<Omit<KVValue, 'value'> | null> {
    return this.recvMeta(address, 'headAny', key);
  }

  async proxyScan(address: string, opts: ScanOptions): Promise<ScanResult> {
    return (await this.jsonAt(address, 'scan', { opts })) as ScanResult;
  }

  async proxyScanReplica(address: string, vnodeIds: string[], opts: ScanOptions): Promise<ScanResult> {
    return (await this.jsonAt(address, 'scanReplica', { vnodeIds, opts })) as ScanResult;
  }

  private async recvValue(address: string, op: string, key: string, vnodeId?: string): Promise<KVValue | null> {
    const res = await this.peer(address).call({ op, key, vnodeId }, undefined, this.timeoutMs);
    const meta = res.json as { missing?: boolean; size?: number; crc?: number; mtimeMs?: number };
    if (meta.missing) {
      return null;
    }
    return { value: res.payload, size: meta.size ?? res.payload.length, crc: meta.crc ?? 0, mtimeMs: meta.mtimeMs ?? 0 };
  }

  private async recvMeta(address: string, op: string, key: string, vnodeId?: string): Promise<Omit<KVValue, 'value'> | null> {
    const res = await this.peer(address).call({ op, key, vnodeId }, undefined, this.timeoutMs);
    const meta = res.json as { missing?: boolean; size?: number; crc?: number; mtimeMs?: number };
    if (meta.missing) {
      return null;
    }
    return { size: meta.size ?? 0, crc: meta.crc ?? 0, mtimeMs: meta.mtimeMs ?? 0 };
  }
}
