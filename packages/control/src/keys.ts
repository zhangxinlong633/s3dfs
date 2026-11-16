/** Block-node registry keys in dleveldb. Object keys should not use this prefix. */
export const NODE_PREFIX = '$node/';

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
  return !isNodeKey(indexKey) && !isReplicaLocatorKey(indexKey);
}
