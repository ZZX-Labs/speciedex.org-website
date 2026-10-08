#!/usr/bin/env python3
from __future__ import annotations
import argparse, shutil
from pathlib import Path

def main():
    p=argparse.ArgumentParser(); p.add_argument('--lookup-root',type=Path,default=Path('static/data/db/lookups')); p.add_argument('--compat-common-names',type=Path,default=Path('static/data/db/indexes/common-names.json')); p.add_argument('--yes',action='store_true'); a=p.parse_args()
    if not a.yes: raise SystemExit('Refusing to purge generated lookups without --yes')
    root=a.lookup_root.resolve()
    if root.exists(): shutil.rmtree(root)
    root.mkdir(parents=True,exist_ok=True)
    compat=a.compat_common_names.resolve()
    if compat.exists(): compat.unlink()
    print(f'Purged generated lookup products only: {root}')
    return 0
if __name__=='__main__': raise SystemExit(main())
