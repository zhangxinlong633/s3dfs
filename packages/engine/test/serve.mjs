import { Store } from '../dist/index.js';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3dfs-http-'));
const store = Store.open({ dataDir: dir, fsyncOnFlush: true, writeThreads: 2 });
const port = store.serve('127.0.0.1', 0, (req) => {
  if (req.url === '/health' && req.method === 'GET') {
    return { status: 200, body: JSON.stringify({ ok: true, url: req.url }), headers: { 'content-type': 'application/json' } };
  }
  return { status: 404, body: '' };
});

const base = `http://127.0.0.1:${port}`;
const key = 'dir/obj';
const put = await fetch(`${base}/_s3dfs/block/put`, {
  method: 'POST',
  headers: {
    'content-type': 'application/octet-stream',
    'x-s3dfs-key': encodeURIComponent(key),
    'x-s3dfs-meta': encodeURIComponent(JSON.stringify({ compressType: 'none', origSize: 5, origCrc: 7 })),
  },
  body: Buffer.from('hello'),
});
if (!put.ok) {
  throw new Error(`put ${put.status} ${await put.text()}`);
}
const loc = await put.json();
if (!loc.recId) {
  throw new Error(`locator ${JSON.stringify(loc)}`);
}

const got = await fetch(`${base}/_s3dfs/block/get?key=${encodeURIComponent(key)}`, {
  headers: {
    'x-s3dfs-key': encodeURIComponent(key),
    'x-s3dfs-locator': encodeURIComponent(JSON.stringify(loc)),
  },
});
if (!got.ok) {
  throw new Error(`get ${got.status}`);
}
const text = Buffer.from(await got.arrayBuffer()).toString();
if (text !== 'hello') {
  throw new Error(`value ${text}`);
}
if (got.headers.get('x-s3dfs-size') !== '5') {
  throw new Error(`size header ${got.headers.get('x-s3dfs-size')}`);
}

const span = await fetch(`${base}/_s3dfs/block/get?key=${encodeURIComponent(key)}&start=1&end=3`, {
  headers: {
    'x-s3dfs-key': encodeURIComponent(key),
    'x-s3dfs-locator': encodeURIComponent(JSON.stringify(loc)),
  },
});
const slice = Buffer.from(await span.arrayBuffer()).toString();
if (slice !== 'ell') {
  throw new Error(`span ${slice}`);
}

const head = await fetch(`${base}/_s3dfs/block/head?key=${encodeURIComponent(key)}`, {
  headers: {
    'x-s3dfs-key': encodeURIComponent(key),
    'x-s3dfs-locator': encodeURIComponent(JSON.stringify(loc)),
  },
});
const meta = await head.json();
if (meta.size !== 5) {
  throw new Error(`head ${JSON.stringify(meta)}`);
}

const health = await fetch(`${base}/health`);
const healthBody = await health.json();
if (!healthBody.ok) {
  throw new Error(`health ${JSON.stringify(healthBody)}`);
}

const begun = await fetch(`${base}/_s3dfs/block/write/begin`, {
  method: 'POST',
  headers: { 'x-s3dfs-key': encodeURIComponent('w') },
});
const { id } = await begun.json();
const chunk = await fetch(`${base}/_s3dfs/block/write/chunk`, {
  method: 'POST',
  headers: { 'x-s3dfs-write': id, 'content-type': 'application/octet-stream' },
  body: Buffer.from('abc'),
});
if (!chunk.ok) {
  throw new Error(`chunk ${chunk.status}`);
}
const finished = await fetch(`${base}/_s3dfs/block/write/finish`, {
  method: 'POST',
  headers: { 'x-s3dfs-write': id },
});
const wloc = await finished.json();
const wgot = await fetch(`${base}/_s3dfs/block/get?key=${encodeURIComponent('w')}`, {
  headers: {
    'x-s3dfs-key': encodeURIComponent('w'),
    'x-s3dfs-locator': encodeURIComponent(JSON.stringify(wloc)),
  },
});
if (Buffer.from(await wgot.arrayBuffer()).toString() !== 'abc') {
  throw new Error('writer value');
}

const removed = await fetch(`${base}/_s3dfs/block/delete`, {
  method: 'POST',
  headers: { 'x-s3dfs-key': encodeURIComponent(key), 'content-type': 'application/json' },
  body: JSON.stringify({ key }),
});
if (!removed.ok) {
  throw new Error(`delete ${removed.status}`);
}

const idle = [];
for (let i = 0; i < 4; i++) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  idle.push(sock);
}
const parked = await fetch(`${base}/_s3dfs/block/put`, {
  method: 'POST',
  headers: { 'x-s3dfs-key': encodeURIComponent('after-idle'), 'content-type': 'application/octet-stream' },
  body: Buffer.from('still-open'),
  signal: AbortSignal.timeout(2000),
});
if (!parked.ok) {
  throw new Error(`put while idle sockets are held ${parked.status}`);
}
for (const sock of idle) {
  sock.destroy();
}

store.close();
console.log('ok', port, loc.recId);
