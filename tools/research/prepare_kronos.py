"""Freeze binary-only runtime resolution and inspect downloaded wheels, without importing them."""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
import zipfile

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[1]
EXPECTED = set('torch einops safetensors huggingface-hub numpy pandas tqdm filelock typing-extensions sympy networkx jinja2 fsspec setuptools packaging pyyaml requests colorama python-dateutil tzdata mpmath markupsafe charset-normalizer idna urllib3 certifi'.split())


def freeze():
    report = json.loads((ROOT / 'data/kronos-install-plan.json').read_text(encoding='utf-8'))
    resources = []
    for item in report['install']:
        meta, download = item['metadata'], item['download_info']
        name = meta['name'].lower().replace('_', '-')
        url = download['url']
        sha = download['archive_info']['hashes']['sha256']
        if urlparse(url).hostname != 'files.pythonhosted.org' or not url.endswith('.whl') or len(sha) != 64:
            raise ValueError('Only hash-pinned PyPI wheels allowed')
        resources.append(dict(name=name, version=meta['version'], wheel=url, sha256=sha,
                              licenseMetadata=meta.get('license_expression') or meta.get('license'),
                              status='resolution-reviewed; wheel-review-pending'))
    if {r['name'] for r in resources} != EXPECTED or len(resources) != len(EXPECTED):
        raise ValueError('Dependency set changed')
    (BASE / 'kronos-win-cp314.lock').write_text(''.join(
        f"{r['name']}=={r['version']} --hash=sha256:{r['sha256']}\n" for r in sorted(resources, key=lambda r:r['name'])))
    (BASE / 'kronos-resources.json').write_text(json.dumps(resources, indent=2))
    print(json.dumps({'packages':len(resources), 'status':'frozen-not-installed'}))


def review():
    path = BASE / 'kronos-resources.json'
    resources = json.loads(path.read_text())
    by_hash = {r['sha256']:r for r in resources}
    found, total = set(), 0
    for wheel in (ROOT / 'work/kronos-review/wheels').glob('*.whl'):
        raw = wheel.read_bytes()
        total += len(raw)
        if total > 500 * 1024 * 1024:
            raise ValueError('Wheel download budget exceeded')
        sha = hashlib.sha256(raw).hexdigest()
        if sha not in by_hash or sha in found:
            raise ValueError('Unexpected or duplicate wheel')
        found.add(sha)
        resource = by_hash[sha]
        notices = []
        with zipfile.ZipFile(wheel) as package:
            for name in package.namelist():
                if name.endswith('.pth'):
                    content = package.read(name).decode('utf-8')
                    expected_hook = "import os; var = 'SETUPTOOLS_USE_DISTUTILS'; enabled = os.environ.get(var, 'local') == 'local'; enabled and __import__('_distutils_hack').add_shim(); \n"
                    if resource['name'] != 'setuptools' or name != 'distutils-precedence.pth' or content != expected_hook:
                        raise ValueError(f'Unreviewed startup hook: {name}: {content!r}')
                    resource['startupHook'] = {'file':name,'content':content,
                                               'purpose':'standard setuptools local distutils import shim'}
                if not name.endswith('/') and any(w in Path(name).name.lower() for w in ('license','licence','notice','copying')):
                    relative = Path(name)
                    if relative.is_absolute() or '..' in relative.parts or package.getinfo(name).file_size > 4 * 1024 * 1024:
                        raise ValueError('Unsafe notice')
                    target = BASE / 'licenses/kronos-dependencies' / resource['name'] / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(package.read(name))
                    notices.append(target.relative_to(ROOT).as_posix())
        if not notices:
            raise ValueError(f"Missing license notice: {resource['name']}")
        resource.update(notices=notices, status='wheel-hash-and-license-verified; runtime-pending')
    if found != set(by_hash):
        raise ValueError('Incomplete wheel set')
    path.write_text(json.dumps(resources, indent=2))
    print(json.dumps({'packages':len(found),'bytes':total,'notices':sum(len(r['notices']) for r in resources)}))


def download():
    subprocess.run([sys.executable, '-m', 'pip', 'download', '--only-binary=:all:', '--require-hashes',
                    '--requirement', str(BASE / 'kronos-win-cp314.lock'),
                    '--dest', str(ROOT / 'work/kronos-review/wheels')], check=True, timeout=600)


def install():
    resources = json.loads((BASE / 'kronos-resources.json').read_text())
    if any(r['status'] != 'wheel-hash-and-license-verified; runtime-pending' for r in resources):
        raise ValueError('Review required before isolated installation')
    interpreter = BASE / '.venv-kronos/Scripts/python.exe'
    subprocess.run([str(interpreter), '-m', 'pip', 'install', '--force-reinstall', '--no-compile', '--no-index', '--only-binary=:all:',
                    '--require-hashes', '--requirement', str(BASE / 'kronos-win-cp314.lock'),
                    '--find-links', str(ROOT / 'work/kronos-review/wheels')], check=True, timeout=900)


def audit(all_files=False):
    if Path(sys.prefix).resolve() != (BASE / '.venv-kronos').resolve():
        raise ValueError('Audit must run inside the isolated Kronos environment')
    resources = json.loads((BASE / 'kronos-resources.json').read_text())
    verified_files = 0
    for resource in resources:
        distribution = importlib.metadata.distribution(resource['name'])
        if distribution.version != resource['version']:
            raise ValueError('Runtime version mismatch')
        for file in (distribution.files or []) if all_files else []:
            if file.hash is None:
                continue
            if file.hash.mode != 'sha256':
                raise ValueError('Unexpected installed file digest algorithm')
            with distribution.locate_file(file).open('rb') as stream:
                digest = base64.urlsafe_b64encode(hashlib.file_digest(stream,'sha256').digest()).rstrip(b'=').decode()
            if digest != file.hash.value:
                raise ValueError(f'Installed file integrity mismatch: {resource["name"]}/{file}')
            verified_files += 1
    import torch
    if (torch.tensor([2,3])*2).tolist() != [4,6]:
        raise ValueError('Torch CPU smoke test failed')
    for resource in resources:
        resource['status'] = 'installed-isolated; version-verified; torch-cpu-smoke-passed'
    (BASE / 'kronos-resources.json').write_text(json.dumps(resources,indent=2))
    print(json.dumps({'packages':len(resources),'installedFilesVerified':verified_files,'torch':torch.__version__,'python':sys.version,
                      'device':'cpu','smokeTest':'passed'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['freeze','download','review','install','audit','audit-files'])
    args = parser.parse_args()
    {'freeze':freeze, 'download':download, 'review':review, 'install':install,
     'audit':audit, 'audit-files':lambda:audit(all_files=True)}[args.action]()
