import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertReleaseAllowed, releaseAssetName } from './deploy-plan.mjs';

const args = process.argv.slice(2).filter((arg) => arg !== '--tag');
const version = args[0];
const tag = process.argv.includes('--tag');

if (!version) {
  console.error('用法: bun scripts/release.mjs 0.1.1 [--tag]');
  process.exit(1);
}

const tests = spawnSync('bun', ['test', 'packages/control/test', 'apps/api/test', 'scripts/deploy.test.mjs'], {
  stdio: 'inherit',
});
let allowed;
try {
  allowed = assertReleaseAllowed({ testsOk: tests.status === 0, version });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
if (tests.status !== 0) {
  process.exit(tests.status ?? 1);
}

const packed = spawnSync('pnpm', ['dist'], { stdio: 'inherit' });
if (packed.status !== 0) {
  process.exit(packed.status ?? 1);
}
writeFileSync('dist/VERSION', `${allowed.version}\n`);
copyFileSync('deploy/使用说明.md', 'dist/使用说明.md');
const asset = releaseAssetName({ version: allowed.version, os: process.platform, arch: process.arch });
mkdirSync('release', { recursive: true });
const archive = path.join('release', asset);
const tar = spawnSync('tar', ['-czf', archive, '-C', 'dist', '.'], { stdio: 'inherit' });
if (tar.status !== 0) {
  process.exit(tar.status ?? 1);
}
console.log(`产出物 ${archive}`);
console.log('解压到 /opt/s3dfs：sudo mkdir -p /opt/s3dfs && sudo tar -C /opt/s3dfs -xzf ' + archive);

if (!tag) {
  console.log(`挂到 GitHub 标签时再运行: bun scripts/release.mjs ${allowed.version} --tag`);
  process.exit(0);
}
const existing = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${allowed.tag}`], { stdio: 'ignore' });
if (existing.status !== 0) {
  const tagged = spawnSync('git', ['tag', '-a', allowed.tag, '-m', `Release ${allowed.tag}`], { stdio: 'inherit' });
  if (tagged.status !== 0) {
    process.exit(tagged.status ?? 1);
  }
}
const pushed = spawnSync('git', ['push', 'origin', allowed.tag], { stdio: 'inherit' });
if (pushed.status !== 0) {
  process.exit(pushed.status ?? 1);
}
const notes = `运行包 ${asset}。解压到 /opt/s3dfs，不要删除 /var/lib/s3dfs。`;
const created = spawnSync('gh', ['release', 'view', allowed.tag], { stdio: 'ignore' });
const uploaded =
  created.status === 0
    ? spawnSync('gh', ['release', 'upload', allowed.tag, archive, '--clobber'], { stdio: 'inherit' })
    : spawnSync('gh', ['release', 'create', allowed.tag, archive, '--title', allowed.tag, '--notes', notes], { stdio: 'inherit' });
if (uploaded.status !== 0) {
  console.error(`标签已推送。把 ${archive} 挂到 GitHub Release 失败。安装并登录 gh 后重试同一条命令。`);
  process.exit(uploaded.status ?? 1);
}
console.log(`已挂到 ${allowed.tag}`);
