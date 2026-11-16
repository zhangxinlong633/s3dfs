export type BlockNodeStatus = 'up' | 'down' | 'unknown';

export interface BlockNodeInfo {
  nodeId: string;
  address: string;
  status: BlockNodeStatus;
  lastSeenMs: number;
  lastError?: string;
}

export interface BlockStats {
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
}

export interface BlockHealth extends BlockNodeInfo {
  stats?: BlockStats;
}

export interface ObjectLocator {
  v: 1;
  replica: number;
  replicaCount: number;
  nodeId: string;
  address: string;
  storageKey: string;
  size: number;
  crc: number;
  mtimeMs: number;
}

export interface ObjectValue {
  value: Buffer;
  size: number;
  crc: number;
  mtimeMs: number;
}

export class ControlError extends Error {
  readonly code: 'INDEX_UNAVAILABLE' | 'BLOCK_UNAVAILABLE' | 'QUORUM_FAILED' | 'BAD_REQUEST';

  constructor(code: ControlError['code'], message: string) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}
