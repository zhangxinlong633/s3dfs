export interface LocatorScanPage {
  objects: { key: string }[];
  truncated: boolean;
}

/** Count v3 locators by node. Pages continue until the index says it is finished. */
export async function countLocators(
  scan: (startAfter?: string) => Promise<LocatorScanPage>,
  read: (key: string) => Promise<Buffer | null>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let startAfter: string | undefined;
  for (;;) {
    const page = await scan(startAfter);
    if (page.objects.length === 0) {
      return counts;
    }
    for (const obj of page.objects) {
      startAfter = obj.key;
      if (obj.key.startsWith('$')) {
        continue;
      }
      const raw = await read(obj.key);
      if (!raw) {
        continue;
      }
      try {
        const loc = JSON.parse(raw.toString('utf8')) as { v?: number; nodeId?: string };
        if (loc.v === 3 && loc.nodeId) {
          counts.set(loc.nodeId, (counts.get(loc.nodeId) ?? 0) + 1);
        }
      } catch {
        // Not a locator.
      }
    }
    if (!page.truncated) {
      return counts;
    }
  }
}
