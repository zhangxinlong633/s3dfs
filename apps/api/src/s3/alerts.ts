export function alertBodies(input: { lostKeys: string[]; layoutOk: boolean; reasons?: string[]; maintenance?: { nodeId: string; reason: string }[] }): string[] {
  const bodies: string[] = [];
  for (const key of input.lostKeys) {
    bodies.push(`lost ${key}`);
  }
  if (!input.layoutOk) {
    bodies.push(`layout ${input.reasons?.join(',') || 'not ok'}`);
  }
  for (const leave of input.maintenance ?? []) {
    bodies.push(`maintenance ${leave.nodeId} ${leave.reason}`);
  }
  return bodies;
}

export async function postAlerts(
  url: string | undefined,
  bodies: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!url || bodies.length === 0) {
    return;
  }
  await Promise.all(
    bodies.map((body) =>
      fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
      }),
    ),
  );
}
