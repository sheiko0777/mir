"""Write reproducible wheel hashes and preserve installed license notices."""
import importlib.metadata
import json
from pathlib import Path

report = json.loads(Path('data/lab-install.json').read_text(encoding='utf-8'))
directory = Path('tools/research/licenses')
directory.mkdir(parents=True, exist_ok=True)
resources, requirements = [], []
for item in report['install']:
    name, version = item['metadata']['name'], item['metadata']['version']
    if name.lower() not in ('duckdb', 'pyarrow'):
        raise ValueError('Unexpected dependency')
    distribution = importlib.metadata.distribution(name)
    if distribution.version != version:
        raise ValueError('Installed version mismatch')
    sha = item['download_info']['archive_info']['hashes']['sha256']
    requirements.append(f'{name}=={version} --hash=sha256:{sha}')
    notices = []
    for file in distribution.files or []:
        if '.dist-info/' in str(file).replace('\\', '/') and any(word in file.name.lower() for word in ('license', 'notice')):
            target = directory / f'{name}-{file.name}'
            target.write_bytes(Path(distribution.locate_file(file)).read_bytes())
            notices.append(str(target).replace('\\', '/'))
    if not notices:
        raise ValueError('Missing package license notices')
    resources.append({'name': name, 'version': version, 'wheel': item['download_info']['url'],
                      'sha256': sha, 'license': item['metadata'].get('license_expression') or item['metadata'].get('license') or ('MIT' if name.lower() == 'duckdb' else None),
                      'requiresDist': item['metadata'].get('requires_dist', []), 'notices': notices,
                      'scope': 'isolated local research; binary wheels; no trading access',
                      'status': 'installed; warehouse integration exercised separately'})
Path('tools/research/requirements-win-cp314.lock').write_text('\n'.join(requirements) + '\n', encoding='utf-8')
Path('tools/research/resources.json').write_text(json.dumps({'platform': 'Windows x64 CPython 3.14',
                                                           'resources': resources}, indent=2), encoding='utf-8')
print(json.dumps({'audited': [r['name'] for r in resources], 'licenses': sum(len(r['notices']) for r in resources)}))
