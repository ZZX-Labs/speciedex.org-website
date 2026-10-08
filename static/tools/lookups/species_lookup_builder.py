#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, re, tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

FIELDS_COMMON=("common_name","commonName","vernacular_name","vernacularName","preferred_common_name","preferredCommonName","english_name","englishName","local_name","localName","fao_english_name","faoEnglishName")
FIELDS_COMMON_LIST=("common_names","commonNames","vernacular_names","vernacularNames","english_names","englishNames","fao_names","faoNames")
TAX_RANKS=("domain","superkingdom","kingdom","subkingdom","phylum","subphylum","class","subclass","order","suborder","family","subfamily","tribe","subtribe","genus","subgenus","species","subspecies")

GROUPS={
"plant":"Plant","fungi":"Fungi","bird":"Bird","fish":"Fish","mammal":"Mammal","reptile":"Reptile","amphibian":"Amphibian","crustacean":"Crustacean","insect":"Insect","arachnid":"Arachnid","mollusk":"Mollusk","worm":"Worm","echinoderm":"Echinoderm","cnidarian":"Cnidarian","sponge":"Sponge","algae":"Algae","protist":"Protist","bacteria":"Bacteria","archaea":"Archaea","virus":"Virus","pollen":"Pollen","coral":"Coral","plankton":"Plankton","fossil":"Fossil / Extinct","other":"Other"}

def clean(v:Any)->str: return str(v or '').strip()
def norm(v:Any)->str: return ' '.join(clean(v).casefold().split())
def uniq(values:Iterable[Any])->list[str]:
    out=[]; seen=set()
    for v in values:
        s=clean(v); k=norm(s)
        if s and k and k not in seen: seen.add(k); out.append(s)
    return out

def containers(record:Mapping[str,Any])->list[Mapping[str,Any]]:
    out=[]
    def add(v):
        if isinstance(v,Mapping) and all(id(v)!=id(x) for x in out): out.append(v)
    add(record); add(record.get('assertion')); add(record.get('extra')); add(record.get('raw'))
    for x in list(out): add(x.get('extra')); add(x.get('raw')); add(x.get('taxonomy')); add(x.get('classification'))
    return out

def scalar_list(v:Any)->list[str]:
    if v is None: return []
    if isinstance(v,(str,int,float)): return [clean(v)] if clean(v) else []
    if isinstance(v,Mapping):
        for k in ('name','value','label','common_name','commonName','vernacular_name','vernacularName'):
            if clean(v.get(k)): return [clean(v.get(k))]
        return []
    if isinstance(v,Sequence) and not isinstance(v,(str,bytes)):
        out=[]
        for x in v: out.extend(scalar_list(x))
        return uniq(out)
    return []

def get_first(record:Mapping[str,Any], fields:Sequence[str])->str:
    for c in containers(record):
        for f in fields:
            s=clean(c.get(f))
            if s: return s
    return ''

def extract_common(record:Mapping[str,Any], scientific:str)->list[str]:
    vals=[]
    for c in containers(record):
        for f in FIELDS_COMMON: vals += scalar_list(c.get(f))
        for f in FIELDS_COMMON_LIST: vals += scalar_list(c.get(f))
    sk=norm(scientific)
    return [x for x in uniq(vals) if norm(x)!=sk]

def extract_taxonomy(record:Mapping[str,Any])->dict[str,str]:
    out={}
    for c in containers(record):
        for rank in TAX_RANKS:
            aliases=(rank, 'class_name' if rank=='class' else '', 'order_name' if rank=='order' else '')
            for a in aliases:
                if a and not out.get(rank) and clean(c.get(a)): out[rank]=clean(c.get(a))
        lineage=c.get('lineage')
        if isinstance(lineage,Sequence) and not isinstance(lineage,(str,bytes)):
            for item in lineage:
                if isinstance(item,Mapping):
                    r=norm(item.get('rank')); n=clean(item.get('name'))
                    if r in TAX_RANKS and n and not out.get(r): out[r]=n
    return out

def assertion_name(record:Mapping[str,Any])->str:
    return get_first(record,("scientific_name","scientificName","canonical_name","canonicalName","name"))

def compatible_name(assertion:Mapping[str,Any], scientific:str, canonical:str)->bool:
    a=norm(assertion_name(assertion))
    if not a: return True
    return a in {norm(scientific), norm(canonical)}

def group_hints(record:Mapping[str,Any])->list[str]:
    vals=[]
    for c in containers(record):
        for f in ('iconic_taxon_name','iconicTaxonName','taxon_group','taxonGroup','group','kingdom_name','kingdomName','phylum_name','phylumName','class_name','className'):
            if clean(c.get(f)): vals.append(clean(c.get(f)))
    return uniq(vals)

def broad_group(record:Mapping[str,Any], taxonomy:Mapping[str,str])->str:
    blob=' '.join(norm(x) for x in [*taxonomy.values(), record.get('rank'), record.get('scientific_name'), record.get('canonical_name'), record.get('material'), record.get('record_type'), *(record.get('group_hints') or []), *group_hints(record)])
    kingdom=norm(taxonomy.get('kingdom')); domain=norm(taxonomy.get('domain')); cls=norm(taxonomy.get('class')); phylum=norm(taxonomy.get('phylum')); order=norm(taxonomy.get('order'))
    # Extinct/fossil material is a display state that should win over the
    # broad living clade icon.  This lets paleobiology records surface as a
    # fossil at a glance while their full taxonomy remains available.
    status_blob = ' '.join(norm(x) for x in [
        record.get('status'), record.get('taxonomic_status'),
        record.get('conservation_status'), record.get('material'),
        record.get('record_type'), *(record.get('group_hints') or [])
    ])
    if any(token in status_blob or token in blob for token in (
        'extinct', 'fossil', 'paleobiology', 'palaeobiology', 'paleontolog',
        'palaeontolog'
    )):
        return 'fossil'
    if 'pollen' in blob: return 'pollen'
    if 'virus' in blob or any(x in blob for x in ('viruses','viridae','riboviria','duplodnaviria','monodnaviria','varidnaviria','adnaviria')): return 'virus'
    if domain=='bacteria' or kingdom in {'bacteria','eubacteria'}: return 'bacteria'
    if domain=='archaea' or kingdom=='archaea': return 'archaea'
    if order in {'scleractinia','alcyonacea'} or cls=='anthozoa': return 'coral'
    if cls=='aves' or 'aves' in blob: return 'bird'
    if cls=='mammalia' or 'mammalia' in blob: return 'mammal'
    if cls in {'reptilia','sauropsida'} or 'reptilia' in blob or 'sauropsida' in blob: return 'reptile'
    if cls=='amphibia' or 'amphibia' in blob: return 'amphibian'
    if cls in {'actinopterygii','chondrichthyes','sarcopterygii','myxini','petromyzontida'}: return 'fish'
    if cls in {'malacostraca','branchiopoda','ostracoda','maxillopoda'} or 'crustacea' in blob: return 'crustacean'
    if cls=='insecta': return 'insect'
    if cls=='arachnida': return 'arachnid'
    if phylum=='mollusca': return 'mollusk'
    if phylum in {'annelida','nematoda','platyhelminthes','nemertea','acanthocephala'}: return 'worm'
    if phylum=='echinodermata': return 'echinoderm'
    if phylum=='cnidaria': return 'cnidarian'
    if phylum=='porifera': return 'sponge'
    if phylum in {'chlorophyta','rhodophyta','ochrophyta','charophyta'} or cls in {'phaeophyceae','bacillariophyceae'}: return 'algae'
    if kingdom=='fungi': return 'fungi'
    if kingdom in {'plantae','viridiplantae'}: return 'plant'
    if kingdom in {'protista','protozoa','chromista'}: return 'protist'
    if 'plankton' in blob: return 'plankton'
    return 'other'

def iter_jsonl(path:Path):
    with path.open(encoding='utf-8') as fh:
        for n,line in enumerate(fh,1):
            s=line.strip()
            if not s: continue
            try: v=json.loads(s)
            except json.JSONDecodeError as e: raise RuntimeError(f'{path}:{n}: {e}')
            if isinstance(v,Mapping): yield v

def atomic_json(path:Path,payload:Any):
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',suffix='.tmp',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f:
            json.dump(payload,f,ensure_ascii=False,sort_keys=True,separators=(',',':')); f.write('\n')
        os.replace(tmp,path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise

def build(taxonomy_root:Path):
    rows={}; by_id={}
    for p in sorted((taxonomy_root/'volumes').glob('*.jsonl')):
        for r in iter_jsonl(p):
            if norm(r.get('rank')) not in {'species','subspecies'}: continue
            sci=clean(r.get('scientific_name') or r.get('canonical_name')); sid=clean(r.get('speciedex_id'))
            if not sci or not sid: continue
            k=norm(sci)
            if k in rows and rows[k]['speciedex_id']!=sid: continue
            tax=extract_taxonomy(r)
            provider=get_first(r,('provider',)) or clean((r.get('initial_source') or {}).get('provider') if isinstance(r.get('initial_source'),Mapping) else '')
            pid=clean((r.get('initial_source') or {}).get('provider_id') if isinstance(r.get('initial_source'),Mapping) else '')
            url=clean((r.get('initial_source') or {}).get('url') if isinstance(r.get('initial_source'),Mapping) else '')
            row={'scientific_name':sci,'speciedex_id':sid,'canonical_name':clean(r.get('canonical_name') or sci),'authorship':clean(r.get('authorship')),'rank':clean(r.get('rank')),'status':clean(r.get('status')),'common_names':extract_common(r,sci),'providers':uniq([provider]),'provider_ids':uniq([pid]),'source_urls':uniq([url]),'date_added':clean(r.get('first_seen') or r.get('created_at')),'last_seen':clean(r.get('last_seen') or r.get('updated_at') or r.get('first_seen')),'source_modified':clean(r.get('source_modified')),'synonyms':scalar_list(r.get('synonyms')),'taxonomy':tax,'group_hints':group_hints(r)}
            row['display_class']=broad_group(r,tax); row['icon']=f"/static/images/taxonomy-classes/{row['display_class']}.png"
            rows[k]=row; by_id[sid]=k
    revisions=0; rejected_name_mismatch=0
    for p in sorted((taxonomy_root/'revisions').glob('*.jsonl')):
        for ev in iter_jsonl(p):
            revisions += 1
            sid=clean(ev.get('speciedex_id') or ev.get('speciedexId')); k=by_id.get(sid)
            if not k: continue
            row=rows[k]; src=ev.get('assertion') if isinstance(ev.get('assertion'),Mapping) else ev
            if not compatible_name(src,row['scientific_name'],row['canonical_name']):
                rejected_name_mismatch += 1; continue
            row['common_names']=uniq([*row['common_names'],*extract_common(src,row['scientific_name'])])
            row['authorship']=row['authorship'] or get_first(src,('authorship','authority','scientific_name_authorship','scientificNameAuthorship'))
            row['canonical_name']=row['canonical_name'] or get_first(src,('canonical_name','canonicalName')) or row['scientific_name']
            row['providers']=uniq([*row['providers'],get_first(src,('provider','source')) or clean(ev.get('provider'))])
            row['provider_ids']=uniq([*row['provider_ids'],get_first(src,('provider_id','providerId','source_id','sourceId')) or clean(ev.get('provider_id'))])
            row['source_urls']=uniq([*row['source_urls'],get_first(src,('source_url','sourceUrl','url'))])
            row['last_seen']=max([x for x in [row['last_seen'],get_first(src,('retrieved_at','retrievedAt','changed_at','changedAt','updated_at','updatedAt')),clean(ev.get('changed_at'))] if x], default='')
            row['source_modified']=max([x for x in [row['source_modified'],get_first(src,('source_modified','sourceModified','modified'))] if x], default='')
            row['synonyms']=uniq([*row['synonyms'],*scalar_list(src.get('synonyms') if isinstance(src,Mapping) else None)])
            tax=extract_taxonomy(src)
            for rk,v in tax.items(): row['taxonomy'].setdefault(rk,v)
            row['group_hints']=uniq([*row.get('group_hints',[]),*group_hints(src)])
            row['display_class']=broad_group(row,row['taxonomy']); row['icon']=f"/static/images/taxonomy-classes/{row['display_class']}.png"
    return rows,revisions,rejected_name_mismatch

def write_all(rows:dict[str,dict], out:Path, only:set[str]|None=None, compat_common:Path|None=None):
    now=datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00','Z')
    ordered=dict(sorted(rows.items()))
    specs={
      'scientific-names': lambda r:{'scientific_name':r['scientific_name'],'speciedex_id':r['speciedex_id']},
      'common-names': lambda r:r['common_names'],
      'canonical-names': lambda r:r['canonical_name'],
      'authorship': lambda r:r['authorship'],
      'provider-sources': lambda r:{'providers':r['providers'],'provider_ids':r['provider_ids'],'source_urls':r['source_urls']},
      'dates': lambda r:{'date_added':r['date_added'],'last_seen':r['last_seen'],'source_modified':r['source_modified']},
      'taxonomy': lambda r:r['taxonomy'],
      'synonyms': lambda r:r['synonyms'],
      'status-rank': lambda r:{'status':r['status'],'rank':r['rank']},
      'display-classes': lambda r:{'display_class':r['display_class'],'icon':r['icon']},
    }
    produced=[]
    for name,fn in specs.items():
        if only and name not in only: continue
        entries={k:fn(r) for k,r in ordered.items() if fn(r) not in ('',[],{},None)}
        payload={'schema_version':1,'kind':f'speciedex-{name}-lookup','key':'normalized_scientific_name','generated_at':now,'count':len(entries),'entries':entries}
        atomic_json(out/f'{name}.json',payload); produced.append(name)
        if name=='common-names' and compat_common:
            byid={r['speciedex_id']:r['common_names'] for r in ordered.values() if r['common_names']}
            atomic_json(compat_common,{'schema_version':2,'kind':'speciedex-common-names-index','generated_at':now,'key':'speciedex_id','count':len(byid),'names':dict(sorted(byid.items()))})
    manifest={'schema_version':1,'kind':'speciedex-species-lookups','generated_at':now,'scientific_species_count':len(ordered),'indexes':produced,'source':'canonical taxonomy volumes + matching provider revisions','matching_rule':'speciedex_id plus compatible scientific/canonical name'}
    atomic_json(out/'manifest.json',manifest)
    return manifest

def main(argv=None):
    ap=argparse.ArgumentParser(); ap.add_argument('--taxonomy-root',type=Path,default=Path('static/data/taxonomy')); ap.add_argument('--output-root',type=Path,default=Path('static/data/db/lookups')); ap.add_argument('--compat-common-names',type=Path,default=Path('static/data/db/indexes/common-names.json')); ap.add_argument('--only',action='append',default=[])
    a=ap.parse_args(argv); rows,revs,rejected=build(a.taxonomy_root.resolve()); only=set(a.only) or None
    manifest=write_all(rows,a.output_root.resolve(),only,a.compat_common_names.resolve() if a.compat_common_names else None)
    print(json.dumps({'species':len(rows),'revision_records_scanned':revs,'revision_name_mismatches_rejected':rejected,'indexes':manifest['indexes']},indent=2)); return 0
if __name__=='__main__': raise SystemExit(main())
