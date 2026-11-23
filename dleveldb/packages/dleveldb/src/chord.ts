import {
  addPow2,
  compareHash,
  HASH_BITS,
  hashToBigInt,
  hashVnode,
  inRange,
  vnodeName,
} from './hash.js';
import type { ChordTransport, VnodeInfo } from './types.js';

const FINGER_COUNT = HASH_BITS;
const DEFAULT_SUCCESSOR_LIST = 4;

export interface LocalVnodeState {
  info: VnodeInfo;
  successor: VnodeInfo;
  predecessor: VnodeInfo | null;
  fingers: (VnodeInfo | null)[];
  successorList: VnodeInfo[];
}

function cloneVnode(v: VnodeInfo): VnodeInfo {
  return { id: v.id, nodeId: v.nodeId, seq: v.seq, hash: v.hash, address: v.address };
}

function sameVnode(a: VnodeInfo | null | undefined, b: VnodeInfo | null | undefined): boolean {
  return !!a && !!b && a.id === b.id && a.address === b.address;
}

export function describeVnode(nodeId: string, seq: number, address: string): VnodeInfo {
  return {
    id: vnodeName(nodeId, seq),
    nodeId,
    seq,
    hash: hashVnode(nodeId, seq),
    address,
  };
}

/** 按哈希排成环上的顺序。 */
export function sortVnodes(vnodes: Iterable<VnodeInfo>): VnodeInfo[] {
  return [...vnodes].sort((a, b) => compareHash(a.hash, b.hash) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function successorOf(sorted: VnodeInfo[], hashHex: string): VnodeInfo | null {
  if (sorted.length === 0) {
    return null;
  }
  const id = hashToBigInt(hashHex);
  for (const vnode of sorted) {
    if (hashToBigInt(vnode.hash) >= id) {
      return vnode;
    }
  }
  return sorted[0] ?? null;
}

/**
 * 从 successor(hash) 起沿环走，挑 N 个位于不同物理机（nodeId）上的 vnode。
 * 同一台机器上的多个虚拟节点只算一份副本。
 */
export function preferenceListOf(
  sorted: VnodeInfo[],
  keyHash: string,
  n: number,
): VnodeInfo[] {
  const take = Math.max(0, n);
  if (take === 0 || sorted.length === 0) {
    return [];
  }
  const start = successorOf(sorted, keyHash);
  if (!start) {
    return [];
  }
  const startIdx = sorted.findIndex((v) => v.id === start.id);
  if (startIdx < 0) {
    return [];
  }
  const result: VnodeInfo[] = [];
  const seenPhys = new Set<string>();
  for (let i = 0; i < sorted.length && result.length < take; i++) {
    const vnode = sorted[(startIdx + i) % sorted.length];
    if (!vnode || seenPhys.has(vnode.nodeId)) {
      continue;
    }
    seenPhys.add(vnode.nodeId);
    result.push(vnode);
  }
  return result;
}

export class ChordRing {
  readonly nodeId: string;
  readonly address: string;
  readonly local: Map<string, LocalVnodeState> = new Map();
  private readonly known = new Map<string, VnodeInfo>();
  /** Unreachable vnodes stay in known so key ownership does not move until repair. */
  private readonly down = new Set<string>();
  private transport: ChordTransport | undefined;
  private successorListLen: number;

  constructor(opts: { nodeId: string; address: string; localVnodes: VnodeInfo[]; successorListLen?: number }) {
    this.nodeId = opts.nodeId;
    this.address = opts.address;
    this.successorListLen = opts.successorListLen ?? DEFAULT_SUCCESSOR_LIST;
    for (const info of opts.localVnodes) {
      const vnode = cloneVnode(info);
      this.known.set(vnode.id, vnode);
      this.local.set(vnode.id, {
        info: vnode,
        successor: vnode,
        predecessor: null,
        fingers: Array.from({ length: FINGER_COUNT }, () => null),
        successorList: [vnode],
      });
    }
    this.formLocalRing();
  }

  setTransport(transport: ChordTransport): void {
    this.transport = transport;
  }

  /** 单机无同伴时，用本地虚拟节点组成一个环。 */
  formLocalRing(): void {
    const sorted = this.sortedLive();
    if (sorted.length === 0) {
      return;
    }
    for (let i = 0; i < sorted.length; i++) {
      const info = sorted[i]!;
      const state = this.local.get(info.id);
      if (!state) {
        continue;
      }
      const succ = sorted[(i + 1) % sorted.length]!;
      const pred = sorted[(i - 1 + sorted.length) % sorted.length]!;
      state.successor = cloneVnode(succ);
      state.predecessor = sorted.length === 1 ? null : cloneVnode(pred);
      this.refillFingers(state, sorted);
      state.successorList = this.buildSuccessorList(info, sorted);
    }
  }

  remember(vnode: VnodeInfo): void {
    if (!vnode?.id) {
      return;
    }
    this.known.set(vnode.id, cloneVnode(vnode));
  }

  rememberAll(vnodes: VnodeInfo[]): void {
    for (const vnode of vnodes) {
      this.remember(vnode);
    }
  }

  forget(vnodeId: string): void {
    if (this.local.has(vnodeId)) {
      return;
    }
    if (this.known.has(vnodeId)) {
      this.down.add(vnodeId);
    }
  }

  isDown(vnodeId: string): boolean {
    return this.down.has(vnodeId);
  }

  markLiveByAddress(address: string): void {
    for (const [id, vnode] of this.known) {
      if (vnode.address === address) {
        this.down.delete(id);
      }
    }
  }

  sortedKnown(): VnodeInfo[] {
    return sortVnodes(this.known.values());
  }

  sortedLive(): VnodeInfo[] {
    return sortVnodes([...this.known.values()].filter((vnode) => !this.down.has(vnode.id)));
  }

  localInfo(): VnodeInfo[] {
    return [...this.local.values()].map((s) => cloneVnode(s.info));
  }

  physicalNodeCount(): number {
    const ids = new Set<string>();
    for (const vnode of this.known.values()) {
      ids.add(vnode.nodeId);
    }
    return Math.max(1, ids.size);
  }

  physicalAddresses(): string[] {
    const addrs = new Set<string>();
    for (const vnode of this.known.values()) {
      addrs.add(vnode.address);
    }
    return [...addrs];
  }

  successor(hashHex: string): VnodeInfo | null {
    return successorOf(this.sortedKnown(), hashHex);
  }

  preferenceList(keyHash: string, n: number): VnodeInfo[] {
    return preferenceListOf(this.sortedKnown(), keyHash, n);
  }

  getState(vnodeId: string): LocalVnodeState | undefined {
    return this.local.get(vnodeId);
  }

  /** 供单测直接注入一整圈已知 vnode。 */
  replaceKnown(vnodes: VnodeInfo[]): void {
    this.known.clear();
    this.down.clear();
    for (const state of this.local.values()) {
      this.known.set(state.info.id, cloneVnode(state.info));
    }
    this.rememberAll(vnodes);
    this.formLocalRing();
    const sorted = this.sortedKnown();
    for (const state of this.local.values()) {
      const next = this.nextOnRing(state.info, sorted) ?? state.info;
      state.successor = cloneVnode(next);
      const pred = this.prevOnRing(state.info, sorted);
      state.predecessor = pred && pred.id !== state.info.id ? cloneVnode(pred) : null;
      this.refillFingers(state, sorted);
      state.successorList = this.buildSuccessorList(state.info, sorted);
    }
  }

  nextOnRing(vnode: VnodeInfo, sorted = this.sortedLive()): VnodeInfo | null {
    if (sorted.length === 0) {
      return null;
    }
    const idx = sorted.findIndex((v) => v.id === vnode.id);
    if (idx < 0) {
      return successorOf(sorted, addPow2(vnode.hash, 0));
    }
    return sorted[(idx + 1) % sorted.length] ?? null;
  }

  prevOnRing(vnode: VnodeInfo, sorted = this.sortedLive()): VnodeInfo | null {
    if (sorted.length === 0) {
      return null;
    }
    const idx = sorted.findIndex((v) => v.id === vnode.id);
    if (idx < 0) {
      return null;
    }
    return sorted[(idx - 1 + sorted.length) % sorted.length] ?? null;
  }

  handleNotify(targetId: string, nprime: VnodeInfo): void {
    this.remember(nprime);
    const state = this.local.get(targetId);
    if (!state) {
      return;
    }
    const pred = state.predecessor;
    if (!pred || inRange(nprime.hash, pred.hash, state.info.hash, { inclusiveStart: false, inclusiveEnd: false })) {
      state.predecessor = cloneVnode(nprime);
    }
  }

  handlePredecessor(vnodeId: string): VnodeInfo | null {
    const state = this.local.get(vnodeId);
    return state?.predecessor ? cloneVnode(state.predecessor) : null;
  }

  handleSuccessorList(vnodeId: string): VnodeInfo[] {
    const state = this.local.get(vnodeId);
    if (!state) {
      return [];
    }
    return state.successorList.map(cloneVnode);
  }

  async findSuccessor(hashHex: string, hops = 0): Promise<VnodeInfo> {
    const knownGuess = successorOf(this.sortedLive(), hashHex);
    if (!knownGuess) {
      const first = this.local.values().next().value as LocalVnodeState | undefined;
      if (!first) {
        throw new Error('empty chord ring');
      }
      return cloneVnode(first.info);
    }

    const pred = this.prevOnRing(knownGuess);
    if (this.local.has(knownGuess.id) || (pred && this.local.has(pred.id) && inRange(hashHex, pred.hash, knownGuess.hash))) {
      return cloneVnode(knownGuess);
    }

    if (hops >= 32 || !this.transport) {
      return cloneVnode(knownGuess);
    }

    const closest = this.closestPreceding(hashHex);
    if (!closest || closest.address === this.address || this.local.has(closest.id)) {
      return cloneVnode(knownGuess);
    }
    try {
      const remote = await this.transport.findSuccessor(closest.address, hashHex, hops + 1);
      this.remember(remote);
      return remote;
    } catch {
      return cloneVnode(knownGuess);
    }
  }

  closestPreceding(hashHex: string): VnodeInfo | null {
    const sorted = this.sortedLive();
    const succ = successorOf(sorted, hashHex);
    if (!succ) {
      return null;
    }
    return this.prevOnRing(succ, sorted);
  }

  async join(peer: string): Promise<void> {
    if (!this.transport) {
      throw new Error('chord transport not set');
    }
    let remoteKnown: VnodeInfo[] = [];
    try {
      remoteKnown = await this.transport.announce(peer, this.localInfo());
      this.rememberAll(remoteKnown);
    } catch {
      // announce 只是加速，失败时退回逐个 find_successor
    }

    for (const state of this.local.values()) {
      const succ = await this.transport.findSuccessor(peer, state.info.hash);
      this.remember(succ);
      state.successor = cloneVnode(succ);
      try {
        await this.transport.notify(succ.address, state.info, succ.id);
      } catch {
        // stabilize 会再试
      }
    }
    this.refreshLocalFromKnown();
  }

  async stabilize(): Promise<void> {
    const transport = this.transport;
    const sorted = this.sortedLive();
    for (const state of this.local.values()) {
      this.refreshStateFromKnown(state, sorted);
      if (!transport) {
        continue;
      }
      const successor = state.successor;
      if (successor.address !== this.address) {
        try {
          const remotePred = await transport.getPredecessor(successor.address, successor.id);
          this.markLiveByAddress(successor.address);
          if (remotePred) {
            this.remember(remotePred);
            this.markLiveByAddress(remotePred.address);
            if (inRange(remotePred.hash, state.info.hash, successor.hash, { inclusiveStart: false, inclusiveEnd: false })) {
              state.successor = cloneVnode(remotePred);
            }
          }
          const list = await transport.getSuccessorList(state.successor.address, state.successor.id);
          this.rememberAll(list);
          const aliveSucc = state.successor;
          await transport.notify(aliveSucc.address, state.info, aliveSucc.id);
        } catch {
          await this.failoverSuccessor(state);
        }
      }
      if (state.predecessor && state.predecessor.address !== this.address && transport) {
        const ok = await transport.ping(state.predecessor.address).catch(() => false);
        if (!ok) {
          this.forget(state.predecessor.id);
          state.predecessor = null;
        }
      }
    }
    this.refreshLocalFromKnown();
  }

  snapshot(): LocalVnodeState[] {
    return [...this.local.values()].map((s) => ({
      info: cloneVnode(s.info),
      successor: cloneVnode(s.successor),
      predecessor: s.predecessor ? cloneVnode(s.predecessor) : null,
      fingers: s.fingers.map((f) => (f ? cloneVnode(f) : null)),
      successorList: s.successorList.map(cloneVnode),
    }));
  }

  private refreshLocalFromKnown(): void {
    const sorted = this.sortedLive();
    for (const state of this.local.values()) {
      this.refreshStateFromKnown(state, sorted);
    }
  }

  private refreshStateFromKnown(state: LocalVnodeState, sorted: VnodeInfo[]): void {
    const next = this.nextOnRing(state.info, sorted);
    if (next) {
      state.successor = cloneVnode(next);
    }
    const pred = this.prevOnRing(state.info, sorted);
    if (pred && pred.id !== state.info.id) {
      if (!state.predecessor || state.predecessor.id === pred.id || !this.known.has(state.predecessor.id)) {
        state.predecessor = cloneVnode(pred);
      }
    }
    this.refillFingers(state, sorted);
    state.successorList = this.buildSuccessorList(state.info, sorted);
  }

  private refillFingers(state: LocalVnodeState, sorted: VnodeInfo[]): void {
    for (let i = 0; i < FINGER_COUNT; i++) {
      const start = addPow2(state.info.hash, i);
      state.fingers[i] = successorOf(sorted, start);
    }
  }

  private buildSuccessorList(vnode: VnodeInfo, sorted: VnodeInfo[]): VnodeInfo[] {
    const list: VnodeInfo[] = [];
    const seen = new Set<string>();
    const start = sorted.findIndex((v) => v.id === vnode.id);
    if (start < 0) {
      return list;
    }
    for (let i = 1; i <= sorted.length && list.length < this.successorListLen; i++) {
      const cand = sorted[(start + i) % sorted.length]!;
      if (seen.has(cand.id)) {
        break;
      }
      seen.add(cand.id);
      list.push(cloneVnode(cand));
    }
    return list;
  }

  private async failoverSuccessor(state: LocalVnodeState): Promise<void> {
    for (const cand of state.successorList) {
      if (cand.id === state.successor.id) {
        continue;
      }
      if (cand.address === this.address) {
        this.forget(state.successor.id);
        state.successor = cloneVnode(cand);
        return;
      }
      if (!this.transport) {
        continue;
      }
      const ok = await this.transport.ping(cand.address).catch(() => false);
      if (ok) {
        this.forget(state.successor.id);
        state.successor = cloneVnode(cand);
        return;
      }
    }
  }
}
