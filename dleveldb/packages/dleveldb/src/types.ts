export interface VnodeInfo {
  /** `{nodeId}-{seq}` */
  id: string;
  nodeId: string;
  seq: number;
  /** SHA-1 hex，40 字符 */
  hash: string;
  /** 该物理节点 API 的 host:port */
  address: string;
}

export interface KVMeta {
  size: number;
  crc: number;
  mtimeMs: number;
}

export interface KVValue extends KVMeta {
  value: Buffer;
}

export interface KVEntry extends KVMeta {
  key: string;
}

export interface ScanOptions {
  prefix?: string;
  startAfter?: string;
  maxKeys?: number;
}

export interface ScanResult {
  objects: KVEntry[];
  truncated: boolean;
}

export interface DLevelDBConfig {
  dataDir: string;
  nodeId: string;
  advertiseAddr: string;
  peers: string[];
  vnodeCount: number;
  replicas: number;
  writeQuorum?: number;
  /** 为 true 时每次写入都刷盘。默认 false，由 syncIntervalMs 定期刷。 */
  sync?: boolean;
  /** 内存中的写入多久刷一次盘。0 表示不按周期刷。sync 为 true 时忽略。 */
  syncIntervalMs?: number;
  /** @deprecated 标准品不再使用 packed block，保留仅为兼容旧调用方。 */
  blockSize?: number;
  /** @deprecated 标准品不再使用 packed block，保留仅为兼容旧调用方。 */
  bufferSize?: number;
  /** 兼容旧字段，等同于 sync。 */
  fsyncOnFlush?: boolean;
  stabilizeIntervalMs: number;
  rpcTimeoutMs: number;
}

export type DLevelDBErrorCode =
  | 'PRIMARY_UNAVAILABLE'
  | 'QUORUM_FAILED'
  | 'TIMEOUT'
  | 'BAD_REQUEST'
  | 'NOT_PRIMARY';

export class DLevelDBError extends Error {
  readonly code: DLevelDBErrorCode;

  constructor(code: DLevelDBErrorCode, message: string) {
    super(message);
    this.name = 'DLevelDBError';
    this.code = code;
  }
}

export interface DLevelDBStats {
  objects: number;
  deleted: number;
  bytesLogical: number;
  bytesOnDisk: number;
  blockFiles: number;
  puts: number;
  gets: number;
  deletes: number;
  flushes: number;
  fsyncs: number;
  indexSlots: number;
  dataDir: string;
  nodeId: string;
  vnodeCount: number;
  peers: string[];
  configuredReplicas: number;
  effectiveReplicas: number;
  writeQuorum: number;
}

export interface DLevelDBStatus {
  layer: '分布式 LevelDB';
  nodeId: string;
  address: string;
  vnodes: {
    id: string;
    seq: number;
    hash: string;
    successor: VnodeInfo | null;
    predecessor: VnodeInfo | null;
    successorList: VnodeInfo[];
  }[];
  peers: string[];
  knownVnodes: VnodeInfo[];
  physicalNodes: number;
  configuredReplicas: number;
  effectiveReplicas: number;
  writeQuorum: number;
  usesLegacyLayout: boolean;
  repair: {
    implemented: boolean;
    note: string;
  };
}

export interface ChordTransport {
  findSuccessor(address: string, hash: string, hops?: number): Promise<VnodeInfo>;
  notify(address: string, vnode: VnodeInfo, targetId: string): Promise<void>;
  getPredecessor(address: string, vnodeId: string): Promise<VnodeInfo | null>;
  getSuccessorList(address: string, vnodeId: string): Promise<VnodeInfo[]>;
  ping(address: string): Promise<boolean>;
  announce(address: string, vnodes: VnodeInfo[]): Promise<VnodeInfo[]>;
}
