/** Block-node registry keys in dleveldb. Object keys should not use this prefix. */
export const NODE_PREFIX = '$node/';

/** Objects with no live copy. The key is `$lost/` plus the object key. */
export const LOST_PREFIX = '$lost/';

/** Name-only change records. The value never contains object bytes. */
export const CHANGE_PREFIX = '$chg/';

export function lostKey(objectKey: string): string {
  return `${LOST_PREFIX}${objectKey}`;
}

export function usageKey(bucket: string): string {
  return `$usage/${bucket}`;
}

/** Replica 0 lives at the object key itself; replica i is `{key}:{i}`. */
export function locatorKey(objectKey: string, replica: number): string {
  if (replica <= 0) {
    return objectKey;
  }
  return `${objectKey}:${replica}`;
}

export function isReplicaLocatorKey(indexKey: string): boolean {
  return /:[1-9]\d*$/.test(indexKey);
}

export function isNodeKey(indexKey: string): boolean {
  return indexKey.startsWith(NODE_PREFIX);
}

export function nodeKey(nodeId: string): string {
  return `${NODE_PREFIX}${nodeId}`;
}

export function nodeIdFromKey(indexKey: string): string | null {
  return indexKey.startsWith(NODE_PREFIX) ? indexKey.slice(NODE_PREFIX.length) : null;
}

export function isVisibleObjectKey(indexKey: string): boolean {
  if (indexKey.startsWith('$') || indexKey.includes('/$')) {
    return false;
  }
  return !isReplicaLocatorKey(indexKey);
}
