#!/usr/bin/env python3
"""Run verified ingestion and publication once or under a continuous supervisor."""
from __future__ import annotations
import argparse,json,signal,subprocess,sys,threading,time
from datetime import datetime,timezone
from pathlib import Path
from providers.common import write_json
from providers.runtime import availability
from providers.archive_lock import ArchiveLock
from providers.readiness import check_scan

def stamp():return datetime.now(timezone.utc).isoformat()
def cycle(root: Path, *, ingest=True, feeds: Path|None=None, rebuild=True):
    started=stamp();runtime=root/'.runtime/maintenance';runtime.mkdir(parents=True,exist_ok=True)
    status_path=root/'static/data/terminal-update-status.json'
    status={'schema_version':1,'request_id':'maintenance-'+str(time.time_ns()),'status':'running','started_at':started,'scope':'all_providers','provider_count':77,'steps':{}}
    write_json(status_path,status)
    def run(*arguments):
        with (runtime/'maintenance.log').open('a',encoding='utf-8') as output:
            result=subprocess.run([sys.executable,*arguments],cwd=root,stdout=output,stderr=subprocess.STDOUT)
        return result.returncode
    try:
        if feeds:status['steps']['feeds']=run('static/tools/sync-provider-feeds.py','--config',str(feeds.resolve()))
        if ingest:status['steps']['ingestion']=run('static/tools/stat-grabber.py','scan','--all-providers','--batch-size','500','--timeout','30','--retries','3')
        if run('static/tools/stat-grabber.py','verify'):raise RuntimeError('Canonical verification failed')
        if rebuild and run('static/tools/database/update-databases.py','--include-canonical-name','--include-taxonomy','--shard-indexes','--rows-per-shard','30000','--target-bytes',str(40*1024*1024),'--max-bytes',str(48*1024*1024),'--verify-parity-arg=--deep'):raise RuntimeError('Database publication failed; previous products retained')
        if run('static/tools/terminal-api.py','--generate-static'):raise RuntimeError('API snapshot build failed')
        registry=json.loads((root/'static/tools/providers.json').read_text())['providers']
        providers=[]
        for definition in registry:
            ready,reason=availability(definition,root)
            state_path=root/'static/data/taxonomy/provider-state'/f"{definition['name']}.json"
            state=json.loads(state_path.read_text()) if state_path.exists() else {}
            provider_status='blocked' if not ready else 'failed' if state.get('last_error') else 'ready'
            providers.append({'provider':definition['name'],'status':provider_status,'reason':reason if not ready else None,'last_success':state.get('last_success'),'next_retry_at':state.get('next_retry_at')})
        counts={name:sum(p['status']==name for p in providers) for name in ['ready','blocked','failed']}
        all_operational=False
        if ingest:
            path=root/'static/data/statistics-sources.json'
            report=json.loads(path.read_text()) if path.is_file() else {}
            gate=check_scan(registry,report)
            try:
                current_cycle=datetime.fromisoformat(report.get('generated_at','').replace('Z','+00:00')) >= datetime.fromisoformat(started).replace(microsecond=0)
            except (ValueError,TypeError):
                current_cycle=False
            gate['current_cycle']=current_cycle
            gate['all_operational']=gate['all_operational'] and current_cycle and status['steps']['ingestion']==0
            status['all_provider_acceptance']=gate
            all_operational=gate['all_operational']
        status.update(status='degraded' if counts['blocked'] or counts['failed'] or any(status['steps'].values()) or ingest and not all_operational else 'completed',completed_at=stamp(),counts=counts,providers=providers,all_operational=all_operational,archive_verified=True,database_verified=True if rebuild else None)
    except Exception as error:
        status.update(status='failed',completed_at=stamp(),error=str(error),last_good_retained=True)
    write_json(status_path,status)
    return status

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--daemon',action='store_true')
    parser.add_argument('--interval',type=int,default=300)
    parser.add_argument('--no-ingest',action='store_true')
    parser.add_argument('--no-rebuild',action='store_true')
    parser.add_argument('--feeds',type=Path)
    args=parser.parse_args()
    if args.interval<60:parser.error('--interval must be at least 60 seconds')
    root=args.repo_root.resolve();stop=threading.Event()
    for kind in (signal.SIGTERM,signal.SIGINT):signal.signal(kind,lambda *_:stop.set())
    lock=ArchiveLock(root/'.runtime/maintenance')
    try:
        while not stop.is_set():
            started=time.monotonic();result=cycle(root,ingest=not args.no_ingest,feeds=args.feeds,rebuild=not args.no_rebuild)
            print(json.dumps({k:v for k,v in result.items() if k!='providers'}),flush=True)
            if not args.daemon:return 1 if result['status']=='failed' else 0
            stop.wait(max(1,args.interval-(time.monotonic()-started)))
    finally:lock.close()
    return 0
if __name__=='__main__':raise SystemExit(main())
