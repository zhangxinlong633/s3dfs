import { NextResponse } from 'next/server';

const ALLOWED = new Set(['flush', 'compact', 'repair', 'scrub', 'maintenance', 'drain', 'rebalance', 'patrol', 'patrol-summary', 'decisions']);

function targetPath(action: string): string {
  if (action === 'patrol-summary') return 'patrol/summary';
  return action;
}

async function forward(request: Request, action: string, method: string): Promise<NextResponse> {
  if (!ALLOWED.has(action)) {
    return NextResponse.json({ error: 'unknown action' }, { status: 404 });
  }
  const incoming = new URL(request.url);
  const base = process.env.S3DFS_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:9000';
  const target = new URL(`${base.replace(/\/$/, '')}/_s3dfs/${targetPath(action)}`);
  incoming.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.S3DFS_PATROL_TOKEN) {
    headers['x-s3dfs-patrol-token'] = process.env.S3DFS_PATROL_TOKEN;
  }
  const body = method === 'GET' ? undefined : await request.text();
  const res = await fetch(target, { method, headers, body: body || undefined });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

export async function GET(request: Request, context: { params: Promise<{ action: string }> }): Promise<NextResponse> {
  const { action } = await context.params;
  return forward(request, action, 'GET');
}

export async function POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<NextResponse> {
  const { action } = await context.params;
  return forward(request, action, 'POST');
}
