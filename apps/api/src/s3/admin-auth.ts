import { verifySigV4 } from './sigv4';

/** Flush, compact, and repair. Open when neither a patrol token nor S3 keys are configured. */
export function adminWriteAllowed(input: {
  headers: Record<string, string | string[] | undefined>;
  env: NodeJS.ProcessEnv;
  path: string;
  method?: string;
  now?: number;
}): boolean {
  const header = (name: string): string | undefined => {
    const raw = input.headers[name] ?? input.headers[name.toLowerCase()];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const token = input.env.S3DFS_PATROL_TOKEN;
  if (token && header('x-s3dfs-patrol-token') === token) {
    return true;
  }
  const accessKeyId = input.env.S3DFS_ACCESS_KEY;
  const secretAccessKey = input.env.S3DFS_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return !token;
  }
  try {
    verifySigV4(
      {
        method: input.method ?? 'POST',
        path: input.path,
        query: new URLSearchParams(),
        headers: input.headers,
        body: Buffer.alloc(0),
        now: input.now,
      },
      { accessKeyId, secretAccessKey },
    );
    return true;
  } catch {
    return false;
  }
}
