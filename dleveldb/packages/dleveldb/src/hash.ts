import { createHash } from 'node:crypto';

/** Chord 标识空间为 SHA-1，160 bit。 */
export const HASH_BITS = 160;
export const HASH_MOD = 1n << BigInt(HASH_BITS);

/** 虚拟节点在环上的位置：SHA-1(utf8(`${nodeId}:${seq}`))，seq 为十进制、不补零。 */
export function hashVnode(nodeId: string, seq: number): string {
  return sha1Hex(`${nodeId}:${seq}`);
}

/** 对象 / KV 键的位置：SHA-1(utf8(key))，与 vnode 同一哈希族。 */
export function hashKey(key: string): string {
  return sha1Hex(key);
}

export function vnodeName(nodeId: string, seq: number): string {
  return `${nodeId}-${seq}`;
}

export function sha1Hex(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashToBigInt(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

export function bigIntToHash(id: bigint): string {
  const normalized = ((id % HASH_MOD) + HASH_MOD) % HASH_MOD;
  return normalized.toString(16).padStart(HASH_BITS / 4, '0');
}

export function addPow2(hashHex: string, power: number): string {
  return bigIntToHash(hashToBigInt(hashHex) + (1n << BigInt(power)));
}

/**
 * 判断 x 是否落在环形区间里。默认是开闭区间 (start, end]，与 Chord 论文一致。
 * start === end 时，(start, end] / [start, end] / [start, end) 视为整个环。
 */
export function inRange(
  x: bigint | string,
  start: bigint | string,
  end: bigint | string,
  options: { inclusiveStart?: boolean; inclusiveEnd?: boolean } = {},
): boolean {
  const xv = typeof x === 'string' ? hashToBigInt(x) : x;
  const s = typeof start === 'string' ? hashToBigInt(start) : start;
  const e = typeof end === 'string' ? hashToBigInt(end) : end;
  const inclusiveStart = options.inclusiveStart ?? false;
  const inclusiveEnd = options.inclusiveEnd ?? true;

  if (s === e) {
    if (inclusiveStart || inclusiveEnd) {
      return true;
    }
    return xv !== s;
  }

  if (s < e) {
    const afterStart = inclusiveStart ? xv >= s : xv > s;
    const beforeEnd = inclusiveEnd ? xv <= e : xv < e;
    return afterStart && beforeEnd;
  }

  const afterStart = inclusiveStart ? xv >= s : xv > s;
  const beforeEnd = inclusiveEnd ? xv <= e : xv < e;
  return afterStart || beforeEnd;
}

export function compareHash(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return hashToBigInt(a) < hashToBigInt(b) ? -1 : 1;
}
