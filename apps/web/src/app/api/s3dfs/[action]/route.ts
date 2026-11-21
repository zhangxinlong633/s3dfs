import { NextResponse } from 'next/server';

const ALLOWED = new Set(['flush', 'compact', 'repair']);

export async function POST(_request: Request, context: { params: Promise<{ action: string }> }): Promise<NextResponse> {
  const { action } = await context.params;
  if (!ALLOWED.has(action)) {
    return NextResponse.json({ error: 'unknown action' }, { status: 404 });
  }
  const base = process.env.S3DFS_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:9000';
  const headers: Record<string, string> = {};
  if (process.env.S3DFS_PATROL_TOKEN) {
    headers['x-s3dfs-patrol-token'] = process.env.S3DFS_PATROL_TOKEN;
  }
  const res = await fetch(`${base}/_s3dfs/${action}`, { method: 'POST', headers });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
