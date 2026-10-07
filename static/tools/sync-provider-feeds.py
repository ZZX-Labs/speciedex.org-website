#!/usr/bin/env python3
"""Refresh explicitly configured provider exports; retain the last valid copy."""
from __future__ import annotations
import argparse,hashlib,json,os,tempfile,urllib.error,urllib.request,urllib.parse,zipfile
from pathlib import Path
from providers.runtime import rows, aliases
from providers.loader import load_provider
from providers.common import write_json, HTTPClient, Taxon, now

def synchronize(root: Path, config: Path, maximum_bytes: int = 512*1024**2) -> dict:
    registry=json.loads((root/'static/tools/providers.json').read_text())['providers']
    definitions={p['name']:p for p in registry}
    configured=json.loads(config.read_text())
    configured=configured.get('providers',configured)
    state_root=root/'.runtime/provider-feeds';state_root.mkdir(parents=True,exist_ok=True)
    results=[]
    for name,settings in configured.items():
        raw=normalized=None
        try:
            definition=definitions[name]
            if definition.get('adapter') not in {'file_jsonl','dwca'}:raise ValueError('Provider uses a native API')
            destination=(root/definition['path']).resolve()
            if not destination.is_relative_to(root.resolve()):raise ValueError('Export path outside repository')
            url=settings['url']
            if urllib.parse.urlsplit(url).scheme!='https':raise ValueError('Feed URL must use HTTPS')
            state_file=state_root/f'{name}.json'
            state=json.loads(state_file.read_text()) if state_file.exists() else {}
            headers=dict(settings.get('headers') or {})
            if destination.exists() and state.get('etag'):headers['If-None-Match']=state['etag']
            if destination.exists() and state.get('last_modified'):headers['If-Modified-Since']=state['last_modified']
            kind=settings.get('format','zip' if definition['adapter']=='dwca' else 'jsonl')
            if kind not in {'jsonl','ndjson','json','csv','tsv','zip','jsonl.gz','json.gz','csv.gz','tsv.gz'}:raise ValueError('Unsupported export format')
            descriptor,temporary=tempfile.mkstemp(dir=state_root,suffix='.'+kind)
            raw=Path(temporary);digest=hashlib.sha256();size=0
            with os.fdopen(descriptor,'wb') as output:
                try:response=urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=60)
                except urllib.error.HTTPError as error:
                    if error.code==304:results.append({'provider':name,'status':'unchanged'});continue
                    raise
                with response:
                    while chunk:=response.read(1024*1024):
                        size+=len(chunk)
                        if size>maximum_bytes:raise ValueError('Feed exceeds maximum size')
                        digest.update(chunk);output.write(chunk)
                    response_state={'etag':response.headers.get('ETag'),'last_modified':response.headers.get('Last-Modified')}
                output.flush();os.fsync(output.fileno())
            if not size:raise ValueError('Empty feed')
            if settings.get('sha256') and digest.hexdigest()!=settings['sha256'].lower():raise ValueError('Feed checksum mismatch')
            count=0
            if kind=='zip':
                with zipfile.ZipFile(raw) as archive:
                    if archive.testzip() is not None:raise ValueError('Corrupt archive')
                    if not any(Path(info.filename).name=='meta.xml' for info in archive.infolist()):raise ValueError('Darwin Core meta.xml missing')
                    if any(Path(info.filename).is_absolute() or '..' in Path(info.filename).parts for info in archive.infolist()):raise ValueError('Unsafe archive member')
                normalized=raw
            else:
                descriptor,temporary=tempfile.mkstemp(dir=state_root,suffix='.jsonl');normalized=Path(temporary)
                provider=load_provider(definition,HTTPClient(),state_root/f'{name}-validation.json',1,root)
                normalize=getattr(provider,'_normalize_record',None) or provider.normalize_record
                with os.fdopen(descriptor,'w',encoding='utf-8') as output:
                    for _,record in rows(raw,{**definition,**settings}):
                        if not isinstance(record,dict) or record.get('__parse_error__'):raise ValueError('Malformed feed record')
                        taxon=normalize(aliases(record),source_path=raw,retrieved_at=now())
                        if not isinstance(taxon,Taxon) or not taxon.provider_id or not taxon.scientific_name:raise ValueError('Feed record has no species identity')
                        count+=1;output.write(json.dumps(record,ensure_ascii=False)+'\n')
                    output.flush();os.fsync(output.fileno())
                if count<max(1,int(settings.get('minimum_records',1))):raise ValueError('Feed has too few records')
            if destination.is_dir():raise ValueError('Configure a ZIP file path for remote Darwin Core feeds')
            destination.parent.mkdir(parents=True,exist_ok=True)
            def file_hash(path):
                value=hashlib.sha256()
                with path.open('rb') as source:
                    while chunk:=source.read(1024*1024):value.update(chunk)
                return value.hexdigest()
            if destination.is_file() and file_hash(destination)==file_hash(normalized):
                status='unchanged'
            else:
                os.chmod(normalized,0o600);os.replace(normalized,destination);status='updated'
            write_json(state_file,{**response_state,'sha256':digest.hexdigest(),'records':count})
            results.append({'provider':name,'status':status,'records':count,'bytes':size})
        except Exception as error:
            results.append({'provider':name,'status':'failed','error':type(error).__name__,'last_good_retained':True})
        finally:
            for temporary in (raw,normalized):
                if temporary and temporary.exists():temporary.unlink()
    return {'configured':len(configured),'results':results,'failed':sum(r['status']=='failed' for r in results)}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--config',type=Path,required=True)
    args=parser.parse_args();report=synchronize(args.repo_root.resolve(),args.config)
    print(json.dumps(report,indent=2));raise SystemExit(bool(report['failed']))
