"""Inspect pinned wheel licenses and import-time hooks before installation."""
import hashlib
import email
import json
import zipfile
from pathlib import Path

path = Path('tools/research/almanak-resources.json')
resources = json.loads(path.read_text(encoding='utf-8'))
by_hash = {r['sha256']: r for r in resources}
supplements = {r['name']:r for r in json.loads(Path('tools/research/almanak-license-supplements.json').read_text(encoding='utf-8'))}
found, hooks, total, missing = set(), [], 0, []
for file in Path('work/almanak-review/wheels').glob('*.whl'):
    raw = file.read_bytes(); total += len(raw)
    if total > 800 * 1024 * 1024: raise ValueError('Artifact budget exceeded')
    sha = hashlib.sha256(raw).hexdigest()
    if sha not in by_hash: raise ValueError('Unreviewed wheel')
    resource = by_hash[sha]; found.add(sha)
    notices = []
    with zipfile.ZipFile(file) as package:
        for name in package.namelist():
            if name.endswith('.pth'):
                if resource['name'] != 'pywin32' or name != 'pywin32.pth': raise ValueError('Unreviewed startup hook')
                hooks.append({'package':resource['name'], 'file':name, 'content':package.read(name).decode('utf-8')})
            if any(word in Path(name).name.lower() for word in ('license', 'licence', 'notice', 'copying')) and not name.endswith('/'):
                contents = package.read(name)
                if len(contents) > 4 * 1024 * 1024: raise ValueError('Notice exceeds bound')
                relative = Path(*Path(name).parts[1:]) if '.dist-info/' in name else Path(name)
                if '..' in relative.parts: raise ValueError('Unsafe notice path')
                target = Path('tools/research/licenses/almanak-dependencies') / resource['name'] / relative
                target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(contents)
                notices.append(str(target).replace('\\','/'))
        if not notices and resource['name'] in supplements:
            supplement = supplements[resource['name']]
            source = package.read(supplement['member'])
            blob = hashlib.sha1(f'blob {len(source)}\0'.encode() + source).hexdigest()
            if resource['version'] != supplement['version'] or blob != supplement['sourceBlob']:
                raise ValueError('Supplement source does not match wheel')
            notices = [str(Path('tools/research/licenses/almanak-dependencies') / resource['name'] / 'UPSTREAM-LICENSE').replace('\\','/')]
            resource['licenseSource'] = supplement['licenseUrl']
            resource['licenseCaveat'] = supplement['note']
        if not notices:
            meta = email.message_from_bytes(package.read(next(n for n in package.namelist() if n.endswith('.dist-info/METADATA'))))
            missing.append({'name':resource['name'], 'home':meta.get('Home-page'), 'projectUrls':meta.get_all('Project-URL'),
                            'classifiers':meta.get_all('Classifier')})
    resource['notices'] = notices
    resource['status'] = 'wheel-checksum-and-notices-verified; install-and-runtime-pending' if notices else 'license-source-verification-required'
if found != set(by_hash): raise ValueError('Incomplete wheel set')
path.write_text(json.dumps(resources,indent=2),encoding='utf-8')
if missing: raise ValueError(f'Unresolved license sources: {missing}')
print(json.dumps({'packages':len(resources),'bytes':total,'notices':sum(len(r['notices']) for r in resources),'startupHooks':hooks,
                  'missingNotices':missing, 'missingLicenseMetadata':[r['name'] for r in resources if not r['licenseMetadata']]}))
