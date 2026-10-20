import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
const files = execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const failures = [];
let bytes = 0;
for (const file of files) {
  if (/(^|\/)(node_modules|data|work|\.git)(\/|$)|(^|\/)\.env(?:\.|$)|config\.toml/.test(file)) failures.push({ file, reason: 'local-only path' });
  const info = await stat(file); bytes += info.size;
  if (info.size > 100 * 1024 * 1024) failures.push({ file, reason: 'file exceeds publishing limit' });
  if (/\.(mjs|cjs|js|json|md|html|css|ya?ml|txt)$/.test(file) || file === '.gitignore') {
    const text = await readFile(file, 'utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[A-Z0-9]{16}\b/.test(text)) failures.push({ file, reason: 'possible credential material' });
  }
}
console.log(JSON.stringify({ files: files.length, bytes, failures }, null, 2));
if (failures.length || !files.length) process.exitCode = 1;
