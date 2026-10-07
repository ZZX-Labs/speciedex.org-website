"""Regression coverage for data loss, stalled cursors and archive publication."""
import importlib.util,json,sqlite3,sys
from pathlib import Path
from unittest.mock import patch
import pytest
from providers.common import HTTPClient,Taxon,ProviderError
from providers.loader import load_provider
from providers.runtime import store_reference
from terminal.database import Database
from terminal.stream import StreamService
TOOLS=Path(__file__).resolve().parents[1]
def module(name,filename):
    spec=importlib.util.spec_from_file_location(name,TOOLS/filename)
    result=importlib.util.module_from_spec(spec);sys.modules[name]=result;spec.loader.exec_module(result);return result
grabber=module('repair_stat_grabber','stat-grabber.py')
def archive(root):return grabber.Archive(root,1024**2,2*1024**2)
def record(provider='fixture',provider_id='1'):
    return Taxon(provider=provider,provider_id=provider_id,scientific_name='Example species',canonical_name='Example species',rank='species',kingdom='Animalia',retrieved_at='2025-01-01T00:00:00Z')

def test_repeated_fetch_time_does_not_grow_revision_journal(tmp_path):
    with archive(tmp_path) as a:
        r=record();identifier=a.add_primary(r)
        journal=next(a.revisions.glob('*.jsonl'));before=journal.read_bytes()
        r.retrieved_at='2026-01-01T00:00:00Z'
        assert not a.attach_assertion(identifier,r)
        assert journal.read_bytes()==before

def test_archive_rejects_overlapping_writer_and_releases_lock(tmp_path):
    first=archive(tmp_path)
    with pytest.raises(RuntimeError,match='Another process'):archive(tmp_path)
    first.close()
    with archive(tmp_path) as reopened:assert reopened.statistics()['species']==0

def test_cache_rebuild_preserves_secondary_source_and_synonyms(tmp_path):
    with archive(tmp_path) as a:
        identifier=a.add_primary(record())
        secondary=record('secondary','s1');secondary.synonyms=['Former species']
        a.attach_assertion(identifier,secondary)
    (tmp_path/'index.sqlite3').unlink()
    with archive(tmp_path) as a:
        assert a.source_match('secondary','s1')==identifier
        assert a.database.execute('SELECT count(*) FROM synonyms').fetchone()[0]==1
        assert a.database.execute('SELECT count(*) FROM assertions').fetchone()[0]==2

def test_corrupt_cache_is_retained_and_rebuilt(tmp_path):
    with archive(tmp_path) as a:identifier=a.add_primary(record())
    original=next((tmp_path/'volumes').glob('*.jsonl')).read_bytes()
    (tmp_path/'index.sqlite3').write_bytes(b'corrupt derived cache')
    with archive(tmp_path) as a:assert a.source_match('fixture','1')==identifier
    assert next((tmp_path/'volumes').glob('*.jsonl')).read_bytes()==original
    assert len(list((tmp_path/'.recovery').glob('*.sqlite3')))==1

def test_invalid_manifest_is_never_silently_replaced(tmp_path):
    (tmp_path/'manifest.json').write_text('{invalid manifest')
    with pytest.raises(ValueError):archive(tmp_path)
    assert (tmp_path/'manifest.json').read_text()=='{invalid manifest'

def test_crash_after_volume_append_recovers_tail(tmp_path):
    with archive(tmp_path) as a:a.add_primary(record())
    volume=next((tmp_path/'volumes').glob('*.jsonl'))
    value=json.loads(volume.read_text());value['identity_key']='another species|species|animalia|';value['scientific_name']=value['canonical_name']='Another species'
    import hashlib
    value['speciedex_id']='spx:sha256:'+hashlib.sha256(value['identity_key'].encode()).hexdigest()
    value['initial_source']['provider_id']='2'
    with volume.open('a') as handle:handle.write(json.dumps(value)+'\n')
    with archive(tmp_path) as a:
        assert a.manifest['total_primary_records']==2
        assert a.database.execute('SELECT count(*) FROM taxa').fetchone()[0]==2

def test_export_batch_commits_cursor_only_on_success_and_quarantines_rows(tmp_path):
    path=tmp_path/'export.jsonl';path.write_text('\ufeff{"id":"1","scientific_name":"Example species"}\nmalformed\n{"id":"2","scientific_name":"Another species"}\n')
    definition={'name':'generic_jsonl','module':'providers.generic_jsonl','adapter':'file_jsonl','path':str(path),'enabled':True}
    p=load_provider(definition,HTTPClient(),tmp_path/'state.json',2,tmp_path)
    batch=p.fetch();assert len(batch.records)==1 and len(batch.rejected)==1
    assert p.cursor is None
    p.save_success(batch);assert len(p.fetch().records)==1
    p.save_success(p.fetch());assert not p.fetch().records
    path.write_text('{"id":"3","scientific_name":"Fresh species"}\n')
    assert p.fetch().records[0].provider_id=='3'

def test_reference_replay_deduplicates_without_changing_taxon_volumes(tmp_path):
    r=record('openalex','W1');r.rank='publication'
    assert store_reference(tmp_path,r)
    (tmp_path/'reference-index.sqlite3').unlink()
    r.retrieved_at='2026-01-01T00:00:00Z'
    assert not store_reference(tmp_path,r)
    assert not (tmp_path/'volumes').exists()

def test_jsonl_resume_avoids_reparsing_committed_prefix_after_restart(tmp_path):
    from providers import runtime
    prefix='\ufeff# export\r\n{"id":"1","scientific_name":"Émú species"}\r\nmalformed\r\n'
    path=tmp_path/'export.ndjson'
    path.write_bytes((prefix+'# next row\n{"id":"2","scientific_name":"Another species"}\n').encode('utf-8'))
    definition={'name':'generic_jsonl','module':'providers.generic_jsonl','adapter':'file_jsonl','path':str(path),'enabled':True}
    state=tmp_path/'state.json'
    provider=load_provider(definition,HTTPClient(),state,2,tmp_path)
    batch=provider.fetch()
    assert len(batch.records)==1 and len(batch.rejected)==1
    assert provider.state.get('export_byte_offset') is None
    provider.save_success(batch)
    assert provider.state['export_byte_offset']==len(prefix.encode('utf-8'))
    assert provider.state['export_row_offset']==2
    reloaded=load_provider(definition,HTTPClient(),state,2,tmp_path)
    original_loads=runtime.json.loads
    def reject_committed_row(text,*args,**kwargs):
        value=original_loads(text,*args,**kwargs)
        if isinstance(value,dict) and value.get('id')=='1':
            raise AssertionError('A committed prefix was parsed again')
        return value
    with patch.object(runtime.json,'loads',side_effect=reject_committed_row):
        resumed=reloaded.fetch()
    assert [item.provider_id for item in resumed.records]==['2']
    assert resumed.exhausted

def test_jsonl_legacy_cursor_and_replacement_reset_keep_all_records(tmp_path):
    path=tmp_path/'export.jsonl'
    path.write_text('{"id":"1","scientific_name":"First species"}\n{"id":"2","scientific_name":"Second species"}\n{"id":"3","scientific_name":"Third species"}\n')
    definition={'name':'generic_jsonl','module':'providers.generic_jsonl','adapter':'file_jsonl','path':str(path),'enabled':True}
    provider=load_provider(definition,HTTPClient(),tmp_path/'state.json',1,tmp_path)
    provider.save_success(provider.fetch())
    provider.state.pop('export_byte_offset')
    provider.state.pop('export_row_offset')
    legacy=provider.fetch()
    assert [item.provider_id for item in legacy.records]==['2']
    provider.save_success(legacy)
    path.write_text('{"id":"4","scientific_name":"Replacement species"}\n')
    reset=provider.fetch()
    assert reset.metadata['source_reset']
    assert [item.provider_id for item in reset.records]==['4']

def test_sharded_search_queries_count_and_paginate_globally(tmp_path):
    for index in range(2):
        with sqlite3.connect(tmp_path/f'{index}.sqlite3') as c:
            c.execute('CREATE TABLE taxa(speciedex_id TEXT,rank TEXT)')
            c.executemany('INSERT INTO taxa VALUES(?,?)',[(str(index*2+n),'species') for n in range(2)])
    (tmp_path/'manifest.json').write_text(json.dumps({'shards':[{'filename':f'{i}.sqlite3'} for i in range(2)]}))
    db=Database(tmp_path)
    assert db.query('SELECT count(*) AS count FROM taxa')[0]['count']==4
    assert [r['speciedex_id'] for r in db.query('SELECT * FROM taxa ORDER BY speciedex_id LIMIT 2 OFFSET 1')]==['1','2']

def test_stream_only_emits_canonical_taxa(tmp_path):
    (tmp_path/'volumes').mkdir();(tmp_path/'rejected').mkdir()
    (tmp_path/'volumes/a.jsonl').write_text('{"scientific_name":"Example species"}\n')
    (tmp_path/'rejected/a.jsonl').write_text('{"error":"not a taxon"}\n')
    (tmp_path/'manifest.json').write_text('{"volumes":[{"file":"volumes/a.jsonl"}]}')
    chunks=list(StreamService(tmp_path).iter_records(limit=10,paced=False))
    assert len(chunks)==1 and 'Example species' in chunks[0] and 'not a taxon' not in chunks[0]

def test_feed_refresh_normalizes_bom_csv_before_publication(tmp_path):
    import io
    (tmp_path/'static/tools').mkdir(parents=True)
    definition={'name':'generic_jsonl','module':'providers.generic_jsonl','adapter':'file_jsonl','path':'static/data/import/feed.jsonl'}
    (tmp_path/'static/tools/providers.json').write_text(json.dumps({'providers':[definition]}))
    config=tmp_path/'config.json';config.write_text(json.dumps({'generic_jsonl':{'url':'https://example.test/export','format':'csv'}}))
    response=io.BytesIO(b'\xef\xbb\xbfid,scientific_name\n1,Example species\n');response.headers={}
    sync=module('repair_sync_feeds','sync-provider-feeds.py')
    with patch('urllib.request.urlopen',return_value=response):report=sync.synchronize(tmp_path,config)
    assert report['failed']==0
    assert json.loads((tmp_path/'static/data/import/feed.jsonl').read_text())['scientific_name']=='Example species'

def test_invalid_feed_retains_previous_export_and_resume_state(tmp_path):
    import io
    (tmp_path/'static/tools').mkdir(parents=True);(tmp_path/'static/data/import').mkdir(parents=True)
    definition={'name':'generic_jsonl','module':'providers.generic_jsonl','adapter':'file_jsonl','path':'static/data/import/feed.jsonl'}
    (tmp_path/'static/tools/providers.json').write_text(json.dumps({'providers':[definition]}))
    config=tmp_path/'config.json';config.write_text(json.dumps({'generic_jsonl':{'url':'https://example.test/export'}}))
    destination=tmp_path/definition['path'];destination.write_text('{"id":"1","scientific_name":"Last valid species"}\n');before=destination.read_bytes()
    response=io.BytesIO(b'not valid JSONL');response.headers={}
    sync=module('repair_sync_bad_feed','sync-provider-feeds.py')
    with patch('urllib.request.urlopen',return_value=response):report=sync.synchronize(tmp_path,config)
    assert report['failed']==1
    assert destination.read_bytes()==before

def test_repeated_api_publication_has_valid_nonrecursive_checksums(tmp_path):
    import hashlib
    from terminal.manifests import ManifestService
    root=tmp_path/'api';root.mkdir()
    (root/'stats.json').write_text('{"records":1}')
    service=ManifestService(tmp_path)
    for count in (1,2):
        (root/'stats.json').write_text(json.dumps({'records':count}))
        manifest=service.write(root/'manifest.json',[root])
        assert [item['path'] for item in manifest['files']]==['api/stats.json']
        checksums=service.write_checksums(root)
        for line in checksums.read_text().splitlines():
            digest,name=line.split(None,1)
            assert name!='api/SHA256SUMS'
            assert hashlib.sha256((tmp_path/name).read_bytes()).hexdigest()==digest

def test_database_inventory_excludes_interrupted_build_files(tmp_path):
    manifests=module('repair_database_manifests','database/build-db-manifests.py')
    (tmp_path/'indexes').mkdir()
    (tmp_path/'indexes/species.json').write_text('[]')
    (tmp_path/'indexes/.species.json.interrupted').write_text('incomplete output')
    (tmp_path/'checksums.json').write_text('{}')
    builder=manifests.DatabaseManifestBuilder(manifests.parse_args(['--db-root',str(tmp_path),'--allow-missing']))
    assert [p.relative_to(tmp_path).as_posix() for p in builder.iter_files()]==['indexes/species.json']

def test_update_stream_skips_unchanged_and_detects_corrections_and_deletions(tmp_path):
    with patch.object(sys,'path',[str(TOOLS/'database'),*sys.path]):
        updates=module('repair_update_deltas','database/update-databases.py')
    taxonomy=tmp_path/'taxonomy';(taxonomy/'volumes').mkdir(parents=True)
    source=taxonomy/'volumes/a.jsonl'
    value={'speciedex_id':'spx:sha256:'+'a'*64,'scientific_name':'Example species','canonical_name':'Example species','rank':'species','status':'accepted','first_seen':'2025-01-01T00:00:00Z','initial_source':{'provider':'fixture','provider_id':'1'},'taxonomy':{'kingdom':'Animalia'}}
    source.write_text(json.dumps(value)+'\n')
    (taxonomy/'manifest.json').write_text('{"volumes":[{"file":"volumes/a.jsonl"}]}')
    normalized=next(updates.iter_canonical_records(taxonomy))
    db=tmp_path/'db';(db/'sqlite').mkdir(parents=True);(db/'indexes').mkdir()
    with sqlite3.connect(db/'sqlite/a.sqlite3') as c:
        c.execute('CREATE TABLE taxa(speciedex_id TEXT,record_hash TEXT)')
        c.execute('INSERT INTO taxa VALUES(?,?)',(normalized['speciedex_id'],normalized['record_hash']))
    (db/'sqlite/manifest.json').write_text('{"records":1,"shards":[{"filename":"a.sqlite3"}]}')
    projection={key:item for key,item in normalized.items() if key not in {'record_hash','payload_json','speciedex_id'}}
    projection['id']=value['speciedex_id'];index=db/'indexes/species.json';index.write_text(json.dumps({value['speciedex_id']:projection}))
    # Legacy browser indexes compare the same projection on both sides.
    legacy=updates.load_previous_index(index)
    assert legacy[value['speciedex_id']]==updates.stable_json(updates.compact_record(normalized))
    def publish():
        updater=updates.DatabaseUpdater(updates.parse_args(['--taxonomy-root',str(taxonomy),'--db-root',str(db),'--in-place','--no-publish']))
        updater.staging_root=db
        updater.previous_hashes=updates.load_previous_index(index,db/'sqlite')
        updater.generate_updates()
        return updater.update_manifest
    assert publish()['totals']=={'records':1,'additions_or_changes':0,'deletions':0}
    value['authorship']='Provider correction';source.write_text(json.dumps(value)+'\n')
    assert publish()['totals']['additions_or_changes']==1
    source.write_text('')
    assert publish()['totals']=={'records':0,'additions_or_changes':0,'deletions':1}
