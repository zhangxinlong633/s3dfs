import { configuredModel, modelAllowed, modelParams } from "./config.js";
import { narrate } from "./narrate.js";
import { attachReport } from "./report.js";

function apiUrl(path: string): string {
  const base = (process.env.S3DFS_PATROL_API_URL ?? "http://127.0.0.1:9000").replace(/\/$/, "");
  return `${base}${path}`;
}

async function requestJson(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      "content-type": "application/json",
      "x-s3dfs-patrol-token": process.env.S3DFS_PATROL_TOKEN ?? "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} returned ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function once(): Promise<Record<string, unknown>> {
  const report = await requestJson("POST", "/_s3dfs/patrol");
  const model = configuredModel();
  if (!model || !modelAllowed(modelParams(process.env, model))) {
    return report;
  }
  try {
    const summary = await narrate(report);
    return await requestJson("POST", "/_s3dfs/patrol/summary", { summary });
  } catch (err) {
    return { ...report, modelError: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const raw = process.env.S3DFS_PATROL_INTERVAL_MS;
  const interval = raw === undefined || raw === "" ? 86_400_000 : Number(raw);
  for (;;) {
    try {
      const written = await attachReport(await once(), process.env);
      console.log(JSON.stringify(written.body));
      if (written.exitCode !== 0) {
        process.exit(written.exitCode);
      }
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

if (import.meta.main) {
  await main();
}
