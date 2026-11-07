import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const directory = new URL('../test/', import.meta.url);
const names = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort();
if (!names.length) throw new Error('MIR test directory is empty');
const files = names.map(name => fileURLToPath(new URL(name, directory)));
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
