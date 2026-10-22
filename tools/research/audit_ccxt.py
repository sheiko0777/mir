import importlib.metadata
import json
from pathlib import Path

path = Path('tools/research/ccxt-resources.json')
resources = json.loads(path.read_text(encoding='utf-8'))
for resource in resources:
    distribution = importlib.metadata.distribution(resource['name'])
    if distribution.version != resource['version']:
        raise ValueError('Installed dependency version mismatch')
    folder = Path('tools/research/licenses/ccxt-dependencies') / resource['name']
    notices = []
    for file in distribution.files or []:
        if '.dist-info/' in str(file).replace('\\', '/') and any(x in file.name.lower() for x in ('license', 'notice', 'copying')):
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / file.name
            target.write_bytes(Path(distribution.locate_file(file)).read_bytes())
            notices.append(str(target).replace('\\', '/'))
    if not notices:
        raise ValueError(f"Missing installed notices: {resource['name']}")
    resource['notices'] = notices
    resource['status'] = 'installed-version-verified; public-adapter-validation-separate'
path.write_text(json.dumps(resources, indent=2), encoding='utf-8')
print(json.dumps({'verifiedPackages': len(resources), 'preservedNotices': sum(len(r['notices']) for r in resources)}))
