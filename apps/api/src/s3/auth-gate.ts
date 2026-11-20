/** Production refuses to listen when strict layout is on and either key is missing. */
export function assertProductionAuth(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.S3DFS_STRICT_LAYOUT;
  const strict = raw === undefined || raw === '' ? true : raw !== '0' && raw.toLowerCase() !== 'false';
  if (!strict) {
    return;
  }
  if (!env.S3DFS_ACCESS_KEY || !env.S3DFS_SECRET_KEY) {
    throw new Error('S3DFS_ACCESS_KEY and S3DFS_SECRET_KEY are required unless S3DFS_STRICT_LAYOUT=0');
  }
}
