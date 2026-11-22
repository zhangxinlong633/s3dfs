import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function copyTree(from, to) {
  if (!existsSync(from)) {
    throw new Error(`missing ${from}; run pnpm build first`);
  }
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
}

function runtimeDeps(pkgPath) {
  const pkg = readJson(pkgPath);
  return pkg.dependencies ?? {};
}

const deps = {
  ...runtimeDeps(path.join(root, 'apps/api/package.json')),
  ...runtimeDeps(path.join(root, 'apps/web/package.json')),
  ...runtimeDeps(path.join(root, 'apps/patrol/package.json')),
};
delete deps['@s3dfs/control'];
delete deps['@s3dfs/engine'];
deps['@s3dfs/control'] = 'file:./packages/control';
deps['@s3dfs/engine'] = 'file:./packages/engine';

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

copyTree(path.join(root, 'apps/api/dist'), path.join(dist, 'api'));
copyTree(path.join(root, 'packages/control/dist'), path.join(dist, 'packages/control/dist'));
copyTree(path.join(root, 'packages/engine/dist'), path.join(dist, 'packages/engine/dist'));

const addonDir = path.join(root, 'packages/engine/build/Release');
const addon = readdirSync(addonDir).find((name) => name.endsWith('.node'));
if (!addon) {
  throw new Error(`no native addon in ${addonDir}; run pnpm build:engine`);
}
const addonOut = path.join(dist, 'packages/engine/build/Release');
mkdirSync(addonOut, { recursive: true });
cpSync(path.join(addonDir, addon), path.join(addonOut, addon));

copyTree(path.join(root, 'apps/web/.next'), path.join(dist, 'web/.next'));
cpSync(path.join(root, 'apps/web/next.config.mjs'), path.join(dist, 'web/next.config.mjs'));

for (const [name, entry] of [
  ['patrol', 'apps/patrol/src/patrol.ts'],
]) {
  const built = spawnSync('bun', ['build', path.join(root, entry), '--outdir', path.join(dist, name), '--target', 'bun', '--packages', 'external'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (built.status !== 0) {
    throw new Error(`bun build ${name} failed`);
  }
}

for (const bin of ['apps/fuse/s3dfs-fuse']) {
  const from = path.join(root, bin);
  if (!existsSync(from)) {
    continue;
  }
  const to = path.join(dist, 'bin', path.basename(bin));
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
}

writeFileSync(
  path.join(dist, 'packages/control/package.json'),
  JSON.stringify(
    {
      name: '@s3dfs/control',
      version: '0.1.0',
      private: true,
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { import: './dist/index.js' } },
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(dist, 'packages/engine/package.json'),
  JSON.stringify(
    {
      name: '@s3dfs/engine',
      version: '0.1.0',
      private: true,
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { import: './dist/index.js', require: './dist/index.js' } },
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(dist, 'package.json'),
  JSON.stringify(
    {
      name: 's3dfs-dist',
      private: true,
      description: 'Release tree. Compiled programs live next to one node_modules.',
      scripts: {
        'start:api': 'bun api/main.js',
        'start:patrol': 'bun patrol/main.js',
        'start:web': 'cd web && ../node_modules/.bin/next start --port 9001 --hostname 0.0.0.0',
      },
      dependencies: deps,
    },
    null,
    2,
  ),
);
writeFileSync(path.join(dist, '.npmrc'), 'ignore-scripts=true\n');

const installed = spawnSync('npm', ['install', '--omit=dev', '--no-package-lock', '--ignore-scripts'], {
  cwd: dist,
  stdio: 'inherit',
});
if (installed.status !== 0) {
  throw new Error('npm install in dist/ failed');
}

console.log(`\nrelease tree: ${dist}`);
console.log('dependencies: dist/node_modules');
