"""Freeze the reviewed pip resolution; does not install or execute a package."""
import json
from pathlib import Path
from urllib.parse import urlparse

report = json.loads(Path('data/ccxt-install-plan.json').read_text(encoding='utf-8'))
expected = {'ccxt', 'certifi', 'requests', 'cryptography', 'typing-extensions', 'aiohttp', 'yarl',
            'aiohttp-fast-zlib', 'zlib-ng', 'winloop', 'orjson', 'aiohappyeyeballs', 'aiosignal',
            'attrs', 'frozenlist', 'multidict', 'propcache', 'cffi', 'pycparser', 'charset-normalizer', 'idna', 'urllib3'}
found, lines, resources = set(), [], []
for item in report['install']:
    metadata = item['metadata']
    name = metadata['name'].lower().replace('_', '-')
    found.add(name)
    url = item['download_info']['url']
    if urlparse(url).hostname != 'files.pythonhosted.org' or not url.endswith('.whl'):
        raise ValueError('Only reviewed PyPI binary wheels permitted')
    sha = item['download_info']['archive_info']['hashes']['sha256']
    lines.append(f"{name}=={metadata['version']} --hash=sha256:{sha}")
    license_value = metadata.get('license_expression') or metadata.get('license')
    if name == 'ccxt': license_value = 'MIT (wheel LICENSE.txt reviewed)'
    resources.append({'name': name, 'version': metadata['version'], 'licenseMetadata': license_value,
                      'wheel': url, 'sha256': sha, 'status': 'reviewed-resolution-not-yet-installed'})
if found != expected:
    raise ValueError('Dependency set changed; review required')
Path('tools/research/ccxt-win-cp314.lock').write_text('\n'.join(sorted(lines)) + '\n', encoding='utf-8')
Path('tools/research/ccxt-resources.json').write_text(json.dumps(resources, indent=2), encoding='utf-8')
print(json.dumps([{'name': r['name'], 'version': r['version'], 'license': str(r['licenseMetadata'])[:100]} for r in resources]))
