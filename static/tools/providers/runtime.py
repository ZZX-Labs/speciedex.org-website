"""Shared resumable export parsing and supplemental-reference journal contract."""
from __future__ import annotations
import csv
import os
from contextlib import closing
import gzip
import hashlib
import json
import sqlite3
from pathlib import Path
from types import MethodType
from typing import Any
from urllib.parse import urlsplit
from .common import Batch, ProviderError, Taxon, now, safe_int


def assertion_hash(value: Any) -> str:
    def stable(item):
        if isinstance(item, dict):
            return {key:stable(val) for key,val in item.items() if key not in {'retrieved_at','fetched_at','crawl','crawl_metadata'}}
        if isinstance(item,list):return [stable(val) for val in item]
        return item
    return hashlib.sha256(json.dumps(stable(value),sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def availability(definition, root):
    if not definition.get('enabled',True):return False,'disabled'
    module = definition.get('module') or definition['name']
    if not str(module).startswith('providers.'):module='providers.'+str(module)
    if not (root/'static/tools'/Path(module.replace('.','/')+'.py')).is_file():return False,'missing module'
    if definition.get('adapter') not in {'file_jsonl','dwca'}:
        import os
        missing=[key for key in definition.get('required_env',[]) if not os.environ.get(key)]
        if missing:return False,'missing environment: '+', '.join(missing)
    elif definition.get('path'):
        path=Path(definition['path']);path=path if path.is_absolute() else root/path
        if not path.exists():return False,'missing dataset: '+str(definition['path'])
    return True,''


def rows(path, definition):
    opener=gzip.open if path.suffix.lower()=='.gz' else open
    suffix=Path(path.stem).suffix if path.suffix.lower()=='.gz' else path.suffix
    with opener(path,'rt',encoding='utf-8-sig',newline='') as handle:
        if suffix.lower() in {'.csv','.tsv','.txt'}:
            yield from enumerate(csv.DictReader(handle,delimiter=definition.get('delimiter') or ('\t' if suffix.lower()!='.csv' else ',')))
        elif suffix.lower()=='.json':
            payload=json.load(handle)
            if isinstance(payload,dict):
                key=definition.get('records_key')
                if key:
                    for part in key.split('.'):payload=payload[part]
                else:payload=next((payload[k] for k in ['records','results','data','taxa','species'] if isinstance(payload.get(k),list)),[payload])
            if not isinstance(payload,list):raise ProviderError('JSON export requires a record list')
            yield from enumerate(payload)
        else:
            number=0
            for line in handle:
                if not line.strip() or line.lstrip().startswith('#'):continue
                try:value=json.loads(line)
                except json.JSONDecodeError:value={'__parse_error__':'invalid JSONL','raw_line':line[:2000].rstrip()}
                yield number,value
                number+=1


def aliases(raw):
    value=dict(raw)
    for key,item in raw.items():value.setdefault(str(key).rsplit('/',1)[-1],item)
    for key,target in {'provider_id':'id','taxonID':'id','scientificname':'scientific_name','taxonRank':'rank','taxonomicStatus':'status','commonName':'common_name','SpecCode':'spec_code','Genus':'genus','Species':'species'}.items():
        if key in value:value.setdefault(target,value[key])
    return value


def export_rows(path, definition, offset, byte_offset=None):
    """Yield record numbers and their next byte position for plain JSONL.

    Positions belong to a specific file signature and committed row cursor.
    Legacy state and other formats retain the existing row-based reader.
    """
    if path.suffix.lower() in {'.gz', '.csv', '.tsv', '.txt', '.json'}:
        for number, raw in rows(path, definition):
            yield number, raw, None
        return
    with path.open('rb') as handle:
        number = offset if byte_offset is not None else 0
        if byte_offset is not None:
            handle.seek(byte_offset)
        while line := handle.readline():
            text = line.decode('utf-8-sig')
            if not text.strip() or text.lstrip().startswith('#'):
                continue
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                value = {'__parse_error__': 'invalid JSONL', 'raw_line': text[:2000].rstrip()}
            yield number, value, handle.tell()
            number += 1


def fetch_export(self):
    configured=self.definition.get('path') or self.definition.get('source_path')
    if not configured:raise ProviderError(f'{self.name} requires an export path')
    path=Path(configured);path=path if path.is_absolute() else self.repo_root/path
    if not path.is_file():raise ProviderError(f'{self.name} export unavailable')
    stat=path.stat();signature=f'{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}'
    prior=self.state.get('export_signature')
    if prior==signature and self.state.get('bootstrap_complete'):return Batch([],None,True,metadata={'source_unchanged':True})
    offset=safe_int(self.cursor,0) if prior==signature else 0
    byte_offset=None
    if prior==signature and self.state.get('export_row_offset')==offset:
        candidate=self.state.get('export_byte_offset')
        if isinstance(candidate,int) and not isinstance(candidate,bool) and 0<=candidate<=stat.st_size:
            byte_offset=candidate
    records=[];rejected=[];raw_count=0;next_offset=offset;exhausted=True
    next_byte_offset=None
    size=max(1,min(self.batch_size,safe_int(self.definition.get('page_size'),self.batch_size) or self.batch_size))
    for number,raw,position in export_rows(path,self.definition,offset,byte_offset):
        if number<offset:continue
        if raw_count>=size:exhausted=False;break
        raw_count+=1;next_offset=number+1
        next_byte_offset=position
        try:
            if not isinstance(raw,dict) or raw.get('__parse_error__'):raise ValueError('Malformed export row')
            normalize=getattr(self,'_normalize_record',None) or self.normalize_record
            record=normalize(aliases(raw),source_path=path,retrieved_at=now())
            if not isinstance(record,Taxon) or not record.scientific_name or not record.provider_id:raise ValueError('No usable provider identity')
            record.provider=self.name;records.append(record)
        except (TypeError,ValueError,KeyError) as error:
            rejected.append({'provider':self.name,'source_file':str(configured),'record_number':number+1,'reason':str(error),'record':raw,'retrieved_at':now()})
            if self.definition.get('strict',False):raise ProviderError(f'{self.name} invalid row {number+1}') from None
    committed={'export_signature':signature,'export_row_offset':next_offset,'export_byte_offset':next_byte_offset}
    return Batch(records,None if exhausted else str(next_offset),exhausted,raw=raw_count,rejected=rejected,metadata={'source_reset':prior!=signature,'committed_state':committed})


def install(provider):
    definition=provider.definition
    host=urlsplit(definition.get('base_url') or getattr(provider,'DEFAULT_BASE_URL','')).hostname
    if host:
        provider.http._rates=getattr(provider.http,'_rates',{})
        provider.http._rates[host]=float(definition.get('rate_limit_per_second',1) or 0)
    if definition.get('adapter')=='file_jsonl':provider.fetch=MethodType(fetch_export,provider)
    return provider


def reference_record(record):
    return record.provider in {'openalex','youtube','biodiversity_heritage_library','crossref','geonames','marine_regions','wdpa','key_biodiversity_areas'} or str(record.rank).lower() in {'publication','video','channel','playlist','media','reference','location','region','protected_area'}


def store_reference(root,record,maximum_bytes=99*1024**2):
    folder=root/'references';folder.mkdir(exist_ok=True)
    cache=root/'reference-index.sqlite3';rebuild=not cache.exists()
    with closing(sqlite3.connect(cache)) as connection, connection:
        connection.execute('CREATE TABLE IF NOT EXISTS references_index(provider TEXT,provider_id TEXT,digest TEXT,PRIMARY KEY(provider,provider_id))')
        if rebuild:
            for path in sorted(folder.glob('*.jsonl')):
                with path.open(encoding='utf-8') as handle:
                    for line in handle:
                        value=json.loads(line);item=value.get('record') or value.get('assertion')
                        if item:connection.execute('INSERT OR REPLACE INTO references_index VALUES(?,?,?)',(item['provider'],item['provider_id'],assertion_hash(item)))
        value=record.to_dict();digest=assertion_hash(value)
        prior=connection.execute('SELECT digest FROM references_index WHERE provider=? AND provider_id=?',(record.provider,record.provider_id)).fetchone()
        if prior and prior[0]==digest:return False
        paths=sorted(folder.glob(f'{record.provider}-*.jsonl'));number=int(paths[-1].stem.rsplit('-',1)[1]) if paths else 1
        path=folder/f'{record.provider}-{number:06d}.jsonl'
        encoded=json.dumps({'event':'reference_upsert','changed_at':now(),'record':value},ensure_ascii=False)+'\n'
        if path.exists() and path.stat().st_size+len(encoded.encode())>maximum_bytes:path=folder/f'{record.provider}-{number+1:06d}.jsonl'
        if len(encoded.encode())>maximum_bytes:raise ProviderError('Reference record exceeds maximum journal size')
        with path.open('a',encoding='utf-8') as handle:handle.write(encoded);handle.flush();os.fsync(handle.fileno())
        connection.execute('INSERT OR REPLACE INTO references_index VALUES(?,?,?)',(record.provider,record.provider_id,digest))
        return True
