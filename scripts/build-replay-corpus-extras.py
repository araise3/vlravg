"""Run the pinned decoder's additional structural readers on every replay."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
import html
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parent.parent
TOOLS=ROOT/'.tools/vrfkit-transcription/tools'


def process(record,out):
    export=Path(record['export'])
    target=out/record['match_id']/'decoded-details'
    target.mkdir(parents=True,exist_ok=True)
    result={'match_id':record['match_id'],'output':str(target),'status':'complete'}
    for name,script,args in (
        ('ground-volumes','extract_ground_volumes.py',['--export-dir',str(export),'--out-dir',str(target/'ground-volumes')]),
        ('ability-structure','extract_fastarray_observations.py',['--export-dir',str(export),'--out-dir',str(target/'ability-structure')]),
        ('world-effects','extract_active_effects.py',['--export',str(export),'--out',str(target/'active-effects.parquet'),'--tracks',str(target/'actor-tracks.parquet')])):
        receipt=target/name/'receipt.json'
        if receipt.exists():
            result[name]=json.loads(receipt.read_text(encoding='utf-8'))
            if result[name].get('counts',{}).get('rejected',0) and result['status']!='incomplete':result['status']='partial'
            continue
        with (target/(name+'.log')).open('wb') as log:
            p=subprocess.run([sys.executable,str(TOOLS/script),*args],stdout=log,stderr=subprocess.STDOUT)
        if receipt.exists():
            result[name]=json.loads(receipt.read_text(encoding='utf-8'))
            if result[name].get('counts',{}).get('rejected',0) and result['status']!='incomplete':result['status']='partial'
            elif p.returncode:
                result[name]['process_returncode']=p.returncode
                result['status']='incomplete'
        elif p.returncode:
            result[name]={'error':f"Return {p.returncode}; see {target/(name+'.log')}"}
            result['status']='incomplete'
        else:result[name]={'status':'written','extractor':script}
    (target/'coverage.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    links=[('coverage.json','Extraction receipts and coverage'),
           ('ground-volumes/windows.ndjson','Ground-volume windows'),
           ('ground-volumes/items.ndjson','Ground-volume polygons and cells'),
           ('ability-structure/observations.ndjson','Numeric ability-state observations'),
           ('active-effects.parquet','World effect actors (Parquet)'),
           ('actor-tracks.parquet','World actor movement tracks (Parquet)')]
    items=''.join(f'<li><a href="{path}">{label}</a></li>' for path,label in links if (target/path).is_file())
    details=html.escape(json.dumps(result,indent=2))
    (target/'index.html').write_text(f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native replay evidence</title><style>body{{max-width:1000px;margin:35px auto;padding:20px;font:14px/1.6 system-ui;color:#222;background:#fafaf7}}pre{{white-space:pre-wrap;overflow-wrap:anywhere}}a{{color:#23688f}}</style><h1>Native replay evidence</h1><p>{html.escape(record["match_id"])} · reader status: {result["status"]}</p><p>These files retain structural observations. Numeric ability-state meanings, world-effect gameplay behavior and rejected volume declarations remain unresolved.</p><ul>{items}</ul><details><summary>Extraction receipts and coverage</summary><pre>{details}</pre></details></html>',encoding='utf-8')
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('corpus',type=Path)
    p.add_argument('--out',required=True,type=Path);p.add_argument('--jobs',type=int,default=2)
    a=p.parse_args();corpus=json.loads(a.corpus.read_text(encoding='utf-8'));records=[]
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        futures=[pool.submit(process,r,a.out) for r in corpus['replays'] if r['status']=='validated']
        for f in as_completed(futures):
            r=f.result();records.append(r);print(f"{len(records)}/{len(futures)} {r['match_id']} {r['status']}",flush=True)
    (a.out/'details.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
    if any(r['status']=='incomplete' for r in records):raise SystemExit(1)


if __name__=='__main__':main()
