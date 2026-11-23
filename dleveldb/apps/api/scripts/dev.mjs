import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist', 'main.js');

function run(command, args, extra = {}) {
  return spawn(command, args, { cwd: root, stdio: 'inherit', ...extra });
}

if (existsSync(join(root, 'dist'))) {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
}

const first = spawn('tsc', ['-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
const code = await new Promise((resolve) => first.on('exit', resolve));
if (code !== 0 || !existsSync(dist)) {
  console.error('dleveldb api: TypeScript build failed');
  process.exit(code || 1);
}

const tsc = run('tsc', ['-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput']);
const app = run('bun', ['--watch', dist]);

const stop = () => {
  tsc.kill('SIGTERM');
  app.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const tscExit = new Promise((resolve) => tsc.on('exit', resolve));
const appExit = new Promise((resolve) => app.on('exit', resolve));
const exited = await Promise.race([tscExit, appExit]);
stop();
process.exit(typeof exited === 'number' ? exited : 0);
