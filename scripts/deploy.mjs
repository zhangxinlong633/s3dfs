import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configFromEnvText, renderDeploy } from './deploy-plan.mjs';

const args = process.argv.slice(2);
const command = args[0];

function flag(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    throw new Error(`缺少 ${name}`);
  }
  return args[index + 1];
}

if (command !== 'render') {
  console.error('用法: bun scripts/deploy.mjs render --env deploy/envs/prod.env --out deploy/out/prod');
  process.exit(1);
}

const envPath = flag('--env');
const outDir = flag('--out');
const files = renderDeploy(configFromEnvText(readFileSync(envPath, 'utf8')));
for (const [name, body] of Object.entries(files)) {
  const file = path.join(outDir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  if (name.endsWith('.sh')) chmodSync(file, 0o755);
}
console.log(`已写出 ${Object.keys(files).length} 个文件到 ${outDir}`);
console.log('密钥写在该目录的 secret.env.example。复制成 secret.env 后再启动。');
console.log('索引和 block 的数据目录在 /var/lib/s3dfs，换版本不要删。');
