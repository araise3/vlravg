"""Build a local, browsable viewer for every validated replay in the corpus."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
import argparse
import base64
import hashlib
import json
import re
from pathlib import Path
import subprocess
import sys
from replay_visibility_inputs import attach_bundle

ROOT=Path(__file__).resolve().parent.parent


def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def refresh_presentation(target):
    """Reuse the exact compressed evidence/geometry when only the UI changed."""
    old=(target/'viewer.html').read_text(encoding='utf-8')
    match=re.search(r'<script id="replay-bundle" type="application/json">(.*?)</script>',old,re.S)
    if not match:return False
    bundle=json.loads(match[1])
    attach_bundle(bundle,json.loads((target/'replay.json').read_text(encoding='utf-8')),target)
    bundle['visibility_runtime_sha256']=digest(ROOT/'scripts/replay-visibility-runtime.js')
    template=(ROOT/'scripts/replay-transcription-template.html').read_text(encoding='utf-8')
    script=(ROOT/'scripts/replay-transcription-viewer.js').read_text(encoding='utf-8')
    visibility=(ROOT/'scripts/replay-visibility-runtime.js').read_text(encoding='utf-8')
    effects=(ROOT/'scripts/replay-visibility-effects.js').read_text(encoding='utf-8')
    behavior=(ROOT/'scripts/replay-behavior-runtime.js').read_text(encoding='utf-8')
    bindings=json.loads((ROOT/'scripts/replay-behavior-asset-bindings.json').read_text(encoding='utf-8'))
    behavior+='\nReplayBehavior.bindAssetPrograms('+json.dumps(bindings).replace('<','\\u003c')+');'
    font=base64.b64encode((ROOT/'scripts/replay-font/DejaVuSans.ttf').read_bytes()).decode('ascii')
    html=template.replace('__REFERENCE_FONT__',font).replace('__BUNDLE__',json.dumps(bundle)).replace('__BEHAVIOR_SCRIPT__',behavior).replace('__VISIBILITY_EFFECTS_SCRIPT__',effects).replace('__VISIBILITY_SCRIPT__',visibility).replace('__VIEWER_SCRIPT__',script)
    (target/'viewer.html').write_text(html,encoding='utf-8')
    return True


def process(record,out,model,signature,presentation_only=False):
    target=out/'library'/record['match_id'];target.mkdir(parents=True,exist_ok=True)
    code=record['map_path'].rsplit('/',1)[-1]
    map_dir=ROOT/'.local/replay-transcripts'/('abyss-map' if code=='Infinity' else f'map-{code}-13.06')
    receipt=target/'build-receipt.json'
    key={**signature,'replay':record['source_sha256'],'map':digest(map_dir/'map.json')}
    if presentation_only:
        if not receipt.exists():raise ValueError('Presentation refresh requires a previous build receipt')
        old=json.loads(receipt.read_text(encoding='utf-8'))
        if old.get('signature',{}).get('replay')!=key['replay'] or old['signature'].get('model')!=key['model'] or old['signature'].get('map')!=key['map']:
            raise ValueError('Presentation refresh cannot change source evidence or model')
        if not refresh_presentation(target):raise ValueError('Existing compressed bundle not found')
        # Preserve backend hashes. The source was not regenerated in this mode.
        for name in ('replay-transcription-viewer.js','replay-transcription-template.html','replay-behavior-runtime.js','replay-behavior-asset-bindings.json','replay-visibility-runtime.js','replay-visibility-effects.js','replay_visibility_inputs.py'):
            old['signature'][name]=key[name]
        old['presentation_refreshed_without_data_rebuild']=True
        receipt.write_text(json.dumps(old,indent=2),encoding='utf-8')
        return old['summary']
    if receipt.exists():
        old=json.loads(receipt.read_text(encoding='utf-8'))
        presentation={'replay-transcription-viewer.js','replay-transcription-template.html','replay-behavior-runtime.js','replay-behavior-asset-bindings.json','replay-visibility-runtime.js','replay-visibility-effects.js','replay_visibility_inputs.py'}
        backend_matches={k:v for k,v in old.get('signature',{}).items() if k not in presentation}=={k:v for k,v in key.items() if k not in presentation}
        if old.get('signature')!=key and backend_matches and (target/'viewer.html').is_file():
            if refresh_presentation(target):old['signature']=key
        if old.get('signature')==key and all((target/name).is_file() for name in ('viewer.html','replay.json','transcript.txt','provenance.json')):
            summary=old['summary']
            extra_path=target/'decoded-details/coverage.json'
            extra=json.loads(extra_path.read_text(encoding='utf-8')) if extra_path.exists() else {}
            summary.update(ground_volume_counts=extra.get('ground-volumes',{}).get('counts',{}),
                ability_structure_counts=extra.get('ability-structure',{}).get('counts',{}),details_status=extra.get('status','not run'),
                details=f"library/{record['match_id']}/decoded-details/index.html")
            old['summary']=summary;receipt.write_text(json.dumps(old,indent=2),encoding='utf-8')
            return summary
    with (target/'build.log').open('wb') as log:
        result=subprocess.run([sys.executable,str(ROOT/'scripts/build-replay-transcription.py'),record['export'],
            '--map',str(map_dir),'--asset-model',str(model),'--out',str(target),'--library-url','../../library.json'],stdout=log,stderr=subprocess.STDOUT)
    if result.returncode:return {'match_id':record['match_id'],'status':'failed','error':f"See {target/'build.log'}"}
    data=json.loads((target/'replay.json').read_text(encoding='utf-8'))
    state=data['asset_state'];obs=state['observations']
    extra_path=target/'decoded-details/coverage.json'
    extra=json.loads(extra_path.read_text(encoding='utf-8')) if extra_path.exists() else {}
    summary={'match_id':record['match_id'],'status':'ready','source_sha256':record['source_sha256'],
        'map_name':data['map']['name'],'map_path':record['map_path'],'rounds':len(data['rounds']),
        'score':data['score'],'agents':sorted(set(p['agent'] for p in data['players'])),
        'native_movement_rows':data['diagnostics']['native_movement_rows'],
        'deaths':len(data['kills']),'vision':dict(Counter(v['kind'] for v in state['vision_effects'])),
        'status_diagnostics':state['diagnostics'],'observation_diagnostics':obs['diagnostics'],
        'ground_volume_counts':extra.get('ground-volumes',{}).get('counts',{}),
        'ability_structure_counts':extra.get('ability-structure',{}).get('counts',{}),
        'details_status':extra.get('status','not run'),'viewer':f"library/{record['match_id']}/viewer.html",
        'data':f"library/{record['match_id']}/replay.json",'text':f"library/{record['match_id']}/transcript.txt",
        'details':f"library/{record['match_id']}/decoded-details/index.html",
        'complete_native_rendering':False}
    receipt.write_text(json.dumps({'signature':key,'summary':summary},indent=2),encoding='utf-8')
    return summary


def write_index(out,rows,corpus):
    totals=Counter()
    for row in rows:
        totals.update(row.get('observation_diagnostics',{}));totals.update({
            'native_movement_rows':row.get('native_movement_rows',0),'deaths':row.get('deaths',0),
            'flash_intervals':row.get('vision',{}).get('flash',0),'nearsight_intervals':row.get('vision',{}).get('nearsight',0)})
    published_rows=[]
    for row in rows:
        item=dict(row)
        estimate=Path('estimated-metrics')/'matches'/(row['match_id']+'.html')
        if (out/estimate).is_file():item['estimated_response']=estimate.as_posix()
        published_rows.append(item)
    index={'schema_version':1,'replays':sorted(published_rows,key=lambda r:(r.get('map_name',''),r['match_id'])),
        'totals':dict(totals),'decoder_revision':corpus['decoder_revision'],'complete_native_rendering':False,
        'limitations':['Recorded effects and animation references do not reconstruct native skeletal blending or shaders.',
                       'World and weapon FOV settings are retained; achieved camera pose, recoil and shake are unresolved.',
                       'Numeric ability-state structures retain unknown semantics; volume polygons retain native declarations.',
                       'Unresolved RPC payloads remain in the hashed source exports. Asset/replay build parity is unverified.']}
    if (out/'estimated-metrics/index.html').is_file():index['estimated_response']='estimated-metrics/index.html'
    (out/'library.json').write_text(json.dumps(index,indent=2),encoding='utf-8')
    template=(ROOT/'scripts/replay-library-template.html').read_text(encoding='utf-8')
    (out/'library.html').write_text(template.replace('__LIBRARY__',json.dumps(index).replace('<','\\u003c')),encoding='utf-8')
    return index


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('corpus',type=Path)
    p.add_argument('--out',type=Path,required=True);p.add_argument('--asset-model',type=Path,required=True)
    p.add_argument('--jobs',type=int,default=2)
    p.add_argument('--presentation-only',action='store_true',help='Refresh UI while preserving the existing evidence and its backend hashes')
    a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    corpus=json.loads(a.corpus.read_text(encoding='utf-8'))
    sources=['build-replay-transcription.py','replay_transcription.py','replay_asset_model.py','replay_status.py','replay_observations.py','replay_bitwindows.py','replay-transcription-viewer.js','replay-transcription-template.html','replay-behavior-runtime.js','replay-behavior-asset-bindings.json','replay-visibility-runtime.js','replay-visibility-effects.js','replay_visibility_inputs.py']
    signature={s:digest(ROOT/'scripts'/s) for s in sources};signature['model']=digest(a.asset_model)
    rows=[]
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        pending=[pool.submit(process,r,a.out,a.asset_model,signature,a.presentation_only) for r in corpus['replays'] if r['status']=='validated']
        for future in as_completed(pending):
            row=future.result();rows.append(row);print(f"{len(rows)}/{len(pending)} {row['match_id']} {row['status']}",flush=True)
            write_index(a.out,rows,corpus)
    index=write_index(a.out,rows,corpus);print(json.dumps(index['totals'],indent=2),flush=True)
    if any(r['status']!='ready' for r in rows):raise SystemExit(1)


if __name__=='__main__':main()
