export type BlockNodeStatus = 'up' | 'down' | 'unknown';
export type CompressType = 'none' | 'zstd' | 'gzip';

export interface BlockNodeInfo {
  nodeId: string;
  address: string;
  status: BlockNodeStatus;
  lastSeenMs: number;
  lastError?: string;
  /** Failure domain. Placement takes one node from a zone before using that zone again. */
  zone?: string;
  /** New writes skip this node until a scale-down finishes or is cancelled. */
  draining?: boolean;
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
  deadBytes?: number;
  tickets?: number;
  unflushedBytes?: number;
}

export interface BlockHealth extends BlockNodeInfo {
  stats?: BlockStats;
}

export interface ExtentLocator {
  chained: boolean;
  crc: number;
  mtimeMs: number;
  size: number;
  generation: number;
  extentCount: number;
  recId: number;
}

export interface ObjectLocator extends ExtentLocator {
  v: 3;
  replica: number;
  replicaCount: number;
  nodeId: string;
  address: string;
  storedSize: number;
  compressType: CompressType;
}

export interface ObjectValue {
  value: Buffer;
  size: number;
  crc: number;
  mtimeMs: number;
  compressType?: CompressType;
}

export function extentFromLocator(loc: ExtentLocator | ObjectLocator): ExtentLocator {
  const storedSize = 'storedSize' in loc && typeof loc.storedSize === 'number' ? loc.storedSize : loc.size;
  return {
    chained: Boolean(loc.chained),
    crc: loc.crc,
    mtimeMs: loc.mtimeMs,
    size: storedSize,
    generation: loc.generation ?? 0,
    extentCount: loc.extentCount ?? 1,
    recId: loc.recId,
  };
}

export class ControlError extends Error {
  readonly code: 'INDEX_UNAVAILABLE' | 'BLOCK_UNAVAILABLE' | 'QUORUM_FAILED' | 'BAD_REQUEST';

  constructor(code: ControlError['code'], message: string) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}
