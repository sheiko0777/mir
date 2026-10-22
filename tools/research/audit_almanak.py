"""Verify installed versions against reviewed, hash-pinned wheel inventory."""
import importlib.metadata
import json
from pathlib import Path
path = Path('tools/research/almanak-resources.json')
resources = json.loads(path.read_text(encoding='utf-8'))
for resource in resources:
    if not resource.get('notices') or any(not Path(p).is_file() for p in resource['notices']):
        raise ValueError('Reviewed notices missing')
    if importlib.metadata.version(resource['name']) != resource['version']:
        raise ValueError(f"Installed version differs: {resource['name']}")
    resource['status'] = 'installed-version-verified; scoped-runtime-probe-separate'
path.write_text(json.dumps(resources,indent=2),encoding='utf-8')
print(json.dumps({'verifiedPackages':len(resources),'notices':sum(len(r['notices']) for r in resources)}))
