export const MIN_PARAMS = 26_000_000_000;
export const DEFAULT_MODEL = "google/gemma-4-26b-a4b";
export const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const DEFAULT_PARAMS = "26000000000";
export const MODULES = ["index", "block", "layout", "repair", "api", "scale", "care"] as const;

export function configuredModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.S3DFS_PATROL_MODEL ?? DEFAULT_MODEL).trim();
  if (raw === "" || raw.toLowerCase() === "off" || raw.toLowerCase() === "none" || raw === "0") {
    return null;
  }
  return raw;
}

/** Unset means the operator asserts the configured model is at least 26B. */
export function modelAllowed(raw: string | undefined, min = MIN_PARAMS): boolean {
  if (raw === undefined || raw === "") {
    return true;
  }
  return Number(raw) >= min;
}

export function modelParams(env: NodeJS.ProcessEnv, model: string | null): string | undefined {
  if (env.S3DFS_PATROL_MODEL_PARAMS) {
    return env.S3DFS_PATROL_MODEL_PARAMS;
  }
  return model === DEFAULT_MODEL ? DEFAULT_PARAMS : undefined;
}
