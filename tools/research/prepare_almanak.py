"""Freeze reviewed binary-wheel resolution; does not install anything."""
import json
import re
from pathlib import Path
from urllib.parse import urlparse

report = json.loads(Path('data/almanak-install-plan.json').read_text(encoding='utf-8'))
if not 1 <= len(report['install']) <= 120: raise ValueError('Dependency budget exceeded')
resources, lines = [], []
for item in report['install']:
    meta = item['metadata']
    name, version = meta['name'].lower().replace('_', '-'), meta['version']
    url = item['download_info']['url']
    sha = item['download_info']['archive_info']['hashes']['sha256']
    if urlparse(url).hostname != 'files.pythonhosted.org' or not url.endswith('.whl') or not re.fullmatch('[a-f0-9]{64}', sha):
        raise ValueError('Only hash-pinned PyPI wheels allowed')
    license_value = meta.get('license_expression') or meta.get('license')
    if name == 'almanak':
        if version != '2.29.2' or sha != '9d7269fc77b06c2e875805936ec0e2420304c8bf21edf771317af6c8f44bf504':
            raise ValueError('Unreviewed SDK artifact')
        license_value = 'Apache-2.0 (actual wheel license inspected separately)'
    resources.append({'name': name, 'version': version, 'licenseMetadata': license_value,
                      'requiresDist': meta.get('requires_dist', []), 'wheel': url, 'sha256': sha,
                      'status': 'resolution-reviewed; wheel-notice-and-startup-hook-review-pending'})
    lines.append(f'{name}=={version} --hash=sha256:{sha}')
Path('tools/research/almanak-win-cp314.lock').write_text('\n'.join(sorted(lines))+'\n', encoding='utf-8')
Path('tools/research/almanak-resources.json').write_text(json.dumps(resources, indent=2), encoding='utf-8')
print(json.dumps([{'name':r['name'],'version':r['version'],'license':str(r['licenseMetadata'])[:90]} for r in resources]))
