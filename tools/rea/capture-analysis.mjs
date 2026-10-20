import { spawn } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, 'outputs/REA-Uniswap-V2');
await mkdir(out, { recursive: true });
const stdout = await open(resolve(out, 'rea-cli-stdout.txt'), 'w');
const stderr = await open(resolve(out, 'rea-cli-stderr.txt'), 'w');
const target = resolve(root, 'tools/rea/reference/node_modules/@uniswap/v2-sdk');
if (target.includes('"') || /[&|<>%\r\n]/.test(target)) throw new Error('Unsupported command path');
// Fixed, selected target; capture directly to artifacts to avoid the shell tool's 2 MiB output cap.
const command = 'npx -y rea-agents@6.7.0 analyze-javascript-application tools/rea/reference/node_modules/@uniswap/v2-sdk --json';
console.log('Capturing complete REA output directly to workspace artifacts.');
const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
  cwd: root, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd],
});
let timer;
try {
  timer = setTimeout(() => child.kill(), 300000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await writeFile(resolve(out, 'rea-cli-run.json'), JSON.stringify({ command, exitCode: code, capture: 'direct file descriptors; no output filtering' }, null, 2) + '\n');
  console.log(JSON.stringify({ exitCode: code, output: resolve(out, 'rea-cli-stdout.txt') }));
  process.exitCode = code === 0 ? 0 : 1;
} finally {
  clearTimeout(timer);
  await stdout.close();
  await stderr.close();
}
