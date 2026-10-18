#!/usr/bin/env python3
"""Download the repository's existing D-Fire model at a fixed revision."""
import hashlib
from pathlib import Path
import urllib.request

REVISION = '13017fe8af477c25f5298d168e2dfede4b000753'
SHA256 = 'b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f'
URL = f'https://huggingface.co/rabahdev/fire-smoke-yolov8n/resolve/{REVISION}/best.pt'


def main():
    target = Path.home() / 'emberwatch-models/fire-smoke-yolov8n.pt'
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == SHA256:
        print('Fire model already verified.')
        return
    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read(10_000_001)
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise SystemExit('Fire model checksum mismatch; existing file preserved.')
    temporary = target.with_suffix('.download')
    temporary.write_bytes(data)
    temporary.replace(target)
    print('Installed and verified fire/smoke model.')


if __name__ == '__main__':
    main()
