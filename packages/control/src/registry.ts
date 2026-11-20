import { createHash } from 'node:crypto';
import { blockHealth } from './block-client.js';
import { NODE_PREFIX, nodeKey } from './keys.js';
import type { IndexClient } from './kv-client.js';
import type { BlockHealth, BlockNodeInfo, BlockNodeStatus } from './types.js';
import { ControlError } from './types.js';

export interface SeedNode {
  nodeId: string;
  address: string;
  zone?: string;
}

export class NodeRegistry {
  private readonly nodes = new Map<string, BlockNodeInfo>();

  constructor(
    private readonly kv: IndexClient,
    seeds: SeedNode[] = [],
  ) {
    for (const seed of seeds) {
        this.nodes.set(seed.nodeId, {
        nodeId: seed.nodeId,
        address: seed.address,
        status: 'unknown',
        lastSeenMs: 0,
        zone: seed.zone,
      });
    }
  }

  list(): BlockNodeInfo[] {
    return [...this.nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  live(): BlockNodeInfo[] {
    const candidates = this.list().filter((node) => !node.draining);
    const up = candidates.filter((n) => n.status === 'up');
    if (up.length > 0) {
      return up;
    }
    // Before the first health pass, allow seeds so a put can still proceed.
    return candidates.filter((n) => n.status === 'unknown');
  }

  noteDraining(nodeId: string, draining: boolean): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }
    this.nodes.set(nodeId, { ...node, draining });
  }

  get(nodeId: string): BlockNodeInfo | undefined {
    return this.nodes.get(nodeId);
  }

  isDown(nodeId: string): boolean {
    return this.nodes.get(nodeId)?.status === 'down';
  }

  async loadFromIndex(): Promise<void> {
    try {
      const listed = await this.kv.scan({ prefix: NODE_PREFIX, maxKeys: 10_000 });
      for (const entry of listed.objects) {
        const raw = await this.kv.get(entry.key);
        if (!raw) {
          continue;
        }
        const parsed = JSON.parse(raw.value.toString('utf8')) as Partial<BlockNodeInfo>;
        if (!parsed.nodeId || !parsed.address) {
          continue;
        }
        const prev = this.nodes.get(parsed.nodeId);
        this.nodes.set(parsed.nodeId, {
          nodeId: parsed.nodeId,
          address: parsed.address,
          status: (parsed.status as BlockNodeStatus) ?? prev?.status ?? 'unknown',
          lastSeenMs: parsed.lastSeenMs ?? prev?.lastSeenMs ?? 0,
          lastError: parsed.lastError,
          zone: parsed.zone ?? prev?.zone,
        });
      }
    } catch {
      // Keep seeds if the index is briefly down.
    }
  }

  async upsert(info: BlockNodeInfo): Promise<void> {
    this.nodes.set(info.nodeId, info);
    await this.kv.put(nodeKey(info.nodeId), Buffer.from(JSON.stringify(info)));
  }

  async checkAll(): Promise<BlockHealth[]> {
    await this.loadFromIndex();
    const results: BlockHealth[] = [];
    for (const node of this.list()) {
      const health = await blockHealth(node.address);
      const next: BlockNodeInfo = health
        ? {
            nodeId: health.nodeId || node.nodeId,
            address: health.address || node.address,
            status: 'up',
            lastSeenMs: Date.now(),
            zone: node.zone,
            draining: node.draining,
          }
        : {
            ...node,
            status: 'down',
            lastError: 'health check failed',
          };
      this.nodes.set(node.nodeId, next);
      try {
        await this.kv.put(nodeKey(node.nodeId), Buffer.from(JSON.stringify(next)));
      } catch {
        // Health still useful locally even if the index write fails.
      }
      results.push({ ...next, stats: health?.stats });
    }
    return results;
  }

  /** Pick `n` distinct live block nodes, starting from a hash of the object key. */
  pick(objectKey: string, n: number): BlockNodeInfo[] {
    const live = this.live();
    if (live.length === 0) {
      throw new ControlError('BLOCK_UNAVAILABLE', 'no live block nodes');
    }
    const want = Math.max(1, Math.min(n, live.length));
    const digest = createHash('sha1').update(objectKey).digest();
    const start = digest.readUInt32BE(0) % live.length;
    const ring = Array.from({ length: live.length }, (_, i) => live[(start + i) % live.length]!);
    const out: BlockNodeInfo[] = [];
    const usedZones = new Set<string>();
    for (const node of ring) {
      if (out.length >= want) {
        break;
      }
      if (node.zone && usedZones.has(node.zone)) {
        continue;
      }
      out.push(node);
      if (node.zone) {
        usedZones.add(node.zone);
      }
    }
    for (const node of ring) {
      if (out.length >= want) {
        break;
      }
      if (!out.includes(node)) {
        out.push(node);
      }
    }
    return out;
  }
}

export function parseBlockNodes(raw: string | undefined): SeedNode[] {
  if (!raw) {
    return [];
  }
  const out: SeedNode[] = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) {
      continue;
    }
    const eq = item.indexOf('=');
    const rawAddress = eq > 0 ? item.slice(eq + 1).trim() : item;
    const at = rawAddress.lastIndexOf('@');
    const zone = at > 0 ? rawAddress.slice(at + 1).trim() : '';
    const address = at > 0 && zone && !zone.includes(':') ? rawAddress.slice(0, at) : rawAddress;
    if (eq > 0) {
      out.push({ nodeId: item.slice(0, eq).trim(), address, zone: zone && address !== rawAddress ? zone : undefined });
      continue;
    }
    const colon = address.lastIndexOf(':');
    const host = colon > 0 ? address.slice(0, colon) : address;
    out.push({
      nodeId: host.replace(/[^A-Za-z0-9._-]+/g, '_') || `block${out.length}`,
      address,
      zone: address !== rawAddress ? zone : undefined,
    });
  }
  return out;
}

export function parseIndexUrls(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}
