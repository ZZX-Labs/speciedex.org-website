#!/usr/bin/env bash
set -Eeuo pipefail

OUTPUT_ROOT="${1:-./speciedex-private-provider-repos}"
REGISTRY="${SPECIEDEX_PROVIDER_REGISTRY:-static/tools/providers.json}"
INIT_GIT="${INIT_GIT:-0}"

if [[ ! -f "$REGISTRY" ]]; then
  printf 'ERROR: provider registry not found: %s\n' "$REGISTRY" >&2
  exit 2
fi

python - "$REGISTRY" "$OUTPUT_ROOT" "$INIT_GIT" <<'PY'
from __future__ import annotations
import json, os, subprocess, sys
from pathlib import Path
registry_path=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve()
init_git=sys.argv[3]=='1'
payload=json.loads(registry_path.read_text(encoding='utf-8'))
providers=payload.get('providers',[])
if len(providers)!=77:
    raise SystemExit(f'expected exactly 77 providers, found {len(providers)}')
names=[str(x.get('name') or '').strip() for x in providers]
if any(not x for x in names) or len(set(names))!=77:
    raise SystemExit('provider registry contains missing or duplicate names')
out.mkdir(parents=True,exist_ok=True)
rows=['provider\trepository\truntime_mode\texpected_import']
for row in providers:
    provider=str(row['name']).strip(); label=str(row.get('label') or provider)
    mode=str(row.get('runtime_mode') or ''); adapter=str(row.get('adapter') or '')
    import_path=str(row.get('path') or ''); required=', '.join(row.get('required_env') or []) or 'none'
    repo='speciedex-provider-'+provider.replace('_','-')
    root=out/repo
    for rel in ('data/raw','data/normalized','data/snapshots','import','manifests','checksums','licenses','docs','scripts'):
        d=root/rel; d.mkdir(parents=True,exist_ok=True); (d/'.gitkeep').touch()
    (root/'.gitignore').write_text('*.tmp\n*.part\n*.lock\n__pycache__/\n.DS_Store\n.runtime/\n',encoding='utf-8')
    (root/'README.md').write_text(f'''# {label} — Speciedex private provider data\n\nPrivate source-data repository for the Speciedex provider `{provider}`.\n\n- Provider ID: `{provider}`\n- Runtime mode: `{mode}`\n- Adapter: `{adapter}`\n- Public ingest target: `{import_path or 'live/API provider'}`\n- Required environment variables: `{required}`\n\n## Layout\n\n`data/raw/` stores immutable acquired source material when permitted.  \n`data/normalized/` stores provider-specific normalized exports.  \n`data/snapshots/` stores dated provider snapshots.  \n`import/` stores the exact file/directory shape mounted into the public Speciedex build.  \n`manifests/` and `checksums/` record provenance and integrity.  \n`licenses/` stores upstream license/terms snapshots and notes.\n\nKeep this repository private. Only store data you are authorized to acquire and retain, and preserve upstream attribution/license requirements.\n''',encoding='utf-8')
    (root/'provider.json').write_text(json.dumps({'schema_version':1,'provider':row},indent=2,ensure_ascii=False,sort_keys=True)+'\n',encoding='utf-8')
    if import_path.startswith('static/data/import/'):
        rel=import_path[len('static/data/import/'):]
        target=root/'import'/rel
        if mode=='darwin_core_archive':
            target.mkdir(parents=True,exist_ok=True); (target/'.gitkeep').touch()
        else:
            target.parent.mkdir(parents=True,exist_ok=True)
            Path(str(target)+'.example').write_text(f'# Replace with the provider export expected at {import_path}\n',encoding='utf-8')
    if init_git and not (root/'.git').exists():
        subprocess.run(['git','-C',str(root),'init','-q'],check=True)
        subprocess.run(['git','-C',str(root),'branch','-M','main'],check=True)
    rows.append(f'{provider}\t{repo}\t{mode}\t{import_path}')
    print(f'created {repo}')
(out/'ALL-PROVIDERS.tsv').write_text('\n'.join(rows)+'\n',encoding='utf-8')
(out/'github-create-private-repos.sh').write_text('#!/usr/bin/env bash\nset -Eeuo pipefail\nOWNER="${1:?usage: $0 GITHUB_OWNER}"\n'+''.join(f'gh repo create "$OWNER/speciedex-provider-{name.replace("_","-")}" --private --source "$(dirname "$0")/speciedex-provider-{name.replace("_","-")}" --remote origin\n' for name in names),encoding='utf-8')
os.chmod(out/'github-create-private-repos.sh',0o755)
print(f'Done: {len(providers)} provider repo scaffolds under {out}')
print('Set INIT_GIT=1 before running this script to initialize each directory as its own git repository.')
PY
