"""Download only public, revision-pinned JSON, model cards and safetensors; never remote code."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'tools/research/kronos-models.json'
MODELS = {'NeoQuasar/Kronos-small':'kronos-small', 'NeoQuasar/Kronos-Tokenizer-base':'kronos-tokenizer-base'}


def fetch(url, limit):
    request = urllib.request.Request(url, headers={'User-Agent':'MIR-read-only-research/1.0'})
    with urllib.request.urlopen(request, timeout=90) as response:
        raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('Download budget exceeded')
    return raw


def plan():
    entries = []
    for repo, folder in MODELS.items():
        metadata = json.loads(fetch(f'https://huggingface.co/api/models/{repo}?blobs=true', 1024*1024))
        if metadata.get('cardData', {}).get('license') != 'mit':
            raise ValueError('Model license requires review')
        sha = metadata['sha']
        if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
            raise ValueError('Invalid revision')
        files = []
        for item in metadata['siblings']:
            name = item['rfilename']
            if name not in ('config.json','README.md','model.safetensors'):
                continue
            files.append({'name':name, 'size':item['size'], 'sha256':item.get('lfs',{}).get('sha256')})
        if {f['name'] for f in files} != {'config.json','README.md','model.safetensors'}:
            raise ValueError('Unexpected model layout')
        entries.append({'repo':repo,'folder':folder,'revision':sha,'license':'MIT','files':files})
    if sum(f['size'] for e in entries for f in e['files']) > 180*1024*1024:
        raise ValueError('Model budget exceeds 180 MiB')
    MANIFEST.write_text(json.dumps(entries,indent=2),encoding='utf-8')
    print(json.dumps(entries))


def download():
    entries = json.loads(MANIFEST.read_text(encoding='utf-8'))
    total = 0
    for entry in entries:
        if MODELS.get(entry['repo']) != entry['folder']:
            raise ValueError('Unknown model')
        for item in entry['files']:
            name = item['name']
            if name not in ('config.json','README.md','model.safetensors'):
                raise ValueError('Remote executable code forbidden')
            raw = fetch(f"https://huggingface.co/{entry['repo']}/resolve/{entry['revision']}/{name}", min(item['size']+1, 180*1024*1024))
            total += len(raw)
            sha = hashlib.sha256(raw).hexdigest()
            if len(raw) != item['size'] or total > 180*1024*1024 or item['sha256'] and sha != item['sha256']:
                raise ValueError('Model checksum or size mismatch')
            item['sha256'] = sha
            target = ROOT / 'tools/models' / entry['folder'] / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
    MANIFEST.write_text(json.dumps(entries,indent=2),encoding='utf-8')
    print(json.dumps({'models':len(entries),'bytes':total,'status':'downloaded-and-sha256-verified'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan','download'])
    {'plan':plan,'download':download}[parser.parse_args().action]()
