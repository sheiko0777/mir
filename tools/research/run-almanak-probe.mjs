import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../',import.meta.url)), temp = join(root,'work/almanak-sandbox/tmp');
await mkdir(temp,{recursive:true});
const child = spawn(join(root,'tools/research/.venv-almanak/Scripts/python.exe'),
  [join(root,'tools/research/almanak_probe.py')], {cwd:root,windowsHide:true,stdio:'inherit',
    env:{SystemRoot:process.env.SystemRoot, TEMP:temp, TMP:temp, PYTHONNOUSERSITE:'1',
      PYTHONDONTWRITEBYTECODE:'1', PYTHONIOENCODING:'utf-8'}});
const timer = setTimeout(()=>child.kill(),60000);
child.once('error',error=>{clearTimeout(timer); console.error(error.message);process.exitCode=1;});
child.once('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
