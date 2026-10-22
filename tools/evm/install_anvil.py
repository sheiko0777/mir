"""Install only reviewed Anvil binary locally; never run upstream shell installers."""
import hashlib
import json
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def download(url, target, limit, expected=None):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and expected and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
        return
    temporary = target.with_suffix(target.suffix + '.partial')
    began, size = time.monotonic(), 0
    try:
        with urllib.request.urlopen(url, timeout=30) as response, temporary.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > limit or time.monotonic() - began > 300:
                    raise ValueError('Download resource budget exceeded')
                output.write(chunk)
        if expected and hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            raise ValueError('Upstream asset checksum mismatch')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def install():
    manifest = json.loads((ROOT / 'tools/evm/anvil-resource.json').read_text(encoding='utf-8'))
    archive = ROOT / 'work/anvil-review' / (manifest['version'] + '.zip')
    download(manifest['archive']['url'], archive, manifest['archive']['bytes'], manifest['archive']['sha256'])
    target = ROOT / 'tools/evm/.bin' / manifest['version'] / 'anvil.exe'
    with zipfile.ZipFile(archive) as package:
        info = package.getinfo('anvil.exe')
        if info.file_size > 200 * 1024 * 1024:
            raise ValueError('Executable exceeds extraction budget')
        binary = package.read(info)
    if hashlib.sha256(binary).hexdigest() != manifest['executableSha256']:
        raise ValueError('Extracted executable differs from reviewed binary')
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_bytes() != binary:
        raise ValueError('Existing version differs; refusing replacement')
    if not target.exists():
        with target.open('xb') as output:
            output.write(binary)
    for name in ('LICENSE-MIT', 'LICENSE-APACHE'):
        download(f"https://raw.githubusercontent.com/foundry-rs/foundry/{manifest['version']}/{name}",
                 ROOT / 'tools/evm/licenses' / name, 64000)
    sbom = ROOT / 'data/evm/foundry.spdx.json'
    download(manifest['sbom']['url'], sbom, manifest['sbom']['bytes'], manifest['sbom']['sha256'])
    receipt = {'version': manifest['version'], 'executable': str(target.relative_to(ROOT)),
               'executableSha256': hashlib.sha256(binary).hexdigest(),
               'archiveSha256': manifest['archive']['sha256'], 'sbomSha256': manifest['sbom']['sha256'],
               'status': 'installed-checksum-verified; runtime-validation-separate'}
    (ROOT / 'data/evm/installation.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__': install()
