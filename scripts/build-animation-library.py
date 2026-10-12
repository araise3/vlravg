"""Publish a local searchable asset-pose library after track sampling checks."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT=Path(__file__).resolve().parent.parent
def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def publish_viewer(out):
    template=(ROOT/'scripts/replay-animation-library-template.html').read_text(encoding='utf-8')
    runtime=(ROOT/'scripts/replay-animation-runtime.js').read_text(encoding='utf-8')
    library=(ROOT/'scripts/replay-animation-library.js').read_text(encoding='utf-8')
    (out/'index.html').write_text(template.replace('__ANIMATION_RUNTIME__',runtime).replace('__ANIMATION_LIBRARY__',library),encoding='utf-8')
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('source',type=Path);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--allow-partial',action='store_true');p.add_argument('--node',default='node');p.add_argument('--additive-source',type=Path);p.add_argument('--blend-source',type=Path);p.add_argument('--presentation-only',action='store_true');a=p.parse_args()
    summary=json.loads((a.source/'summary.json').read_text());manifest=json.loads((a.source/'manifest.json').read_text())
    if not summary['complete_inspection'] and not a.allow_partial:raise ValueError('Finish installed animation export first')
    if manifest['exporter_sha256']!=digest(ROOT/'scripts/export-installed-animations.py'):raise ValueError('Animation exporter provenance changed')
    if a.presentation_only:
        report=json.loads((a.out/'catalog.json').read_text());validation=report['validation']
        if report['provenance']!=manifest:raise ValueError('Animation presentation source differs')
        if validation['runtime_sha256']!=digest(ROOT/'scripts/replay-animation-runtime.js') or validation['checker_sha256']!=digest(ROOT/'scripts/check-replay-animation.cjs'):raise ValueError('Revalidate changed animation runtime/checker')
        if validation['index_sha256']!=digest(a.source/'index.jsonl'):raise ValueError('Animation source index changed')
        if report.get('raw_additive'):
            if not a.additive_source:raise ValueError('Raw additive source required')
            raw=report['raw_additive'];rv=raw['validation'];rm=json.loads((a.additive_source/'manifest.json').read_text())
            if raw['provenance']!=rm or rm['exporter_sha256']!=digest(ROOT/'scripts/export-additive-animation-tracks.py'):raise ValueError('Raw additive source differs')
            if rv['runtime_sha256']!=digest(ROOT/'scripts/replay-animation-runtime.js') or rv['checker_sha256']!=digest(ROOT/'scripts/check-additive-animation.cjs'):raise ValueError('Revalidate changed additive runtime/checker')
            if rv['index_sha256']!=digest(a.additive_source/'index.jsonl'):raise ValueError('Additive source index changed')
        if report.get('typed_blendspaces'):
            if not a.blend_source:raise ValueError('Typed blend-space source required')
            br=report['typed_blendspaces'];bv=br['validation'];bm=json.loads((a.blend_source/'manifest.json').read_text())
            if br['provenance']!=bm or bm['exporter_sha256']!=digest(ROOT/'scripts/export-blendspace-metadata.py'):raise ValueError('Blend-space source differs')
            if bv['runtime_sha256']!=digest(ROOT/'scripts/replay-animation-runtime.js') or bv['checker_sha256']!=digest(ROOT/'scripts/check-blendspace-metadata.cjs'):raise ValueError('Revalidate changed blend runtime/checker')
            if bv['index_sha256']!=digest(a.blend_source/'index.jsonl'):raise ValueError('Blend-space source index changed')
        publish_viewer(a.out);print('Refreshed animation presentation with unchanged validated records');return
    validation=json.loads(subprocess.check_output([a.node,str(ROOT/'scripts/check-replay-animation.cjs'),str(a.source)],text=True))
    if validation['runtime_sha256']!=digest(ROOT/'scripts/replay-animation-runtime.js'):raise ValueError('Animation validation runtime differs')
    a.out.mkdir(parents=True,exist_ok=True);target=a.out/'records';target.mkdir(exist_ok=True)
    rows={r['package']:r for l in (a.source/'index.jsonl').read_text().splitlines() if (r:=json.loads(l))}
    # Immutable gzip records can be linked on the same volume; cross-volume
    # callers fall back to copying. Neither changes source data bytes.
    for file in a.source.glob('*.json.gz'):
        dest=target/file.name
        if dest.exists():
            if digest(dest)!=digest(file):raise ValueError('Existing animation record differs: '+file.name)
            continue
        try:os.link(file,dest)
        except OSError:shutil.copyfile(file,dest)
    catalog=[]
    for row in rows.values():
        for e in row['exports']:catalog.append({**e,'package':row['package'],'file':'records/'+row['file'],'source_record_sha256':row['sha256']})
    preview_gaps={r['object_path']:r['reason'] for r in validation['preview_gaps']}
    for item in catalog:
        if item['class']=='AnimSequence':item['pose_preview']={'known':item['object_path'] not in preview_gaps,'gap':preview_gaps.get(item['object_path'])}
    additive_report=None
    if a.additive_source:
        additive_summary=json.loads((a.additive_source/'summary.json').read_text())
        additive_manifest=json.loads((a.additive_source/'manifest.json').read_text())
        if not additive_summary['complete_inspection'] and not a.allow_partial:raise ValueError('Finish raw additive export first')
        if additive_manifest['source_index_sha256']!=digest(a.source/'index.jsonl'):raise ValueError('Additive source inventory differs')
        if additive_manifest['exporter_sha256']!=digest(ROOT/'scripts/export-additive-animation-tracks.py'):raise ValueError('Raw additive exporter changed')
        additive_validation=json.loads(subprocess.check_output([a.node,str(ROOT/'scripts/check-additive-animation.cjs'),str(a.additive_source)],text=True))
        additive_target=target/'additive';additive_target.mkdir(exist_ok=True)
        for file in a.additive_source.glob('*.json.gz'):
            dest=additive_target/file.name
            if dest.exists():
                if digest(dest)!=digest(file):raise ValueError('Existing raw additive record differs')
                continue
            try:os.link(file,dest)
            except OSError:shutil.copyfile(file,dest)
        additive_rows={r['package']:r for l in (a.additive_source/'index.jsonl').read_text().splitlines() if (r:=json.loads(l))}
        items={item['object_path']:item for item in catalog};additive_gaps={r['object_path']:r['reason'] for r in additive_validation['preview_gaps']}
        additive_errors=[]
        for row in additive_rows.values():
            if row['source_record_sha256']!=rows[row['package']]['sha256']:raise ValueError('Original converted animation record differs')
            for e in row['exports']:
                item=items[e['object_path']];item['converted_source_file']=item['file'];item['converted_source_record_sha256']=item['source_record_sha256']
                item.update(file='records/additive/'+row['file'],source_record_sha256=row['sha256'],track_format='raw_additive_delta_tracks',
                    pose_preview={'known':e['object_path'] not in additive_gaps,'gap':additive_gaps.get(e['object_path']),'requires_explicit_base_pose':True})
            if row['errors']:
                content=json.loads(gzip.decompress((a.additive_source/row['file']).read_bytes()))
                additive_errors.extend(content['errors'])
        additive_report={**additive_summary,'provenance':additive_manifest,'validation':additive_validation,'errors':additive_errors}
        (a.out/'additive-validation.json').write_text(json.dumps(additive_validation,indent=2),encoding='utf-8')
    blend_report=None
    if a.blend_source:
        blend_summary=json.loads((a.blend_source/'summary.json').read_text());blend_manifest=json.loads((a.blend_source/'manifest.json').read_text())
        if not blend_summary['complete_inspection']:raise ValueError('Finish typed blend-space export')
        if blend_manifest['source_index_sha256']!=digest(a.source/'index.jsonl') or blend_manifest['exporter_sha256']!=digest(ROOT/'scripts/export-blendspace-metadata.py'):raise ValueError('Blend-space provenance differs')
        blend_validation=json.loads(subprocess.check_output([a.node,str(ROOT/'scripts/check-blendspace-metadata.cjs'),str(a.blend_source)],text=True))
        blend_target=target/'blend';blend_target.mkdir(exist_ok=True)
        for file in a.blend_source.glob('*.json.gz'):
            dest=blend_target/file.name
            if dest.exists():
                if digest(dest)!=digest(file):raise ValueError('Existing blend-space record differs')
                continue
            try:os.link(file,dest)
            except OSError:shutil.copyfile(file,dest)
        items={item['object_path']:item for item in catalog};blend_errors=[]
        for line in (a.blend_source/'index.jsonl').read_text().splitlines():
            row=json.loads(line)
            if row['source_record_sha256']!=rows[row['package']]['sha256']:raise ValueError('Original blend-space record differs')
            for e in row['exports']:
                item=items[e['object_path']];item['original_metadata_file']=item['file'];item['original_metadata_sha256']=item['source_record_sha256']
                item.update(file='records/blend/'+row['file'],source_record_sha256=row['sha256'],metadata_kind='typed_blendspace_arrays')
            if row['errors']:blend_errors.append({'package':row['package'],'details':json.loads(gzip.decompress((a.blend_source/row['file']).read_bytes()))['errors']})
        blend_report={**blend_summary,'provenance':blend_manifest,'validation':blend_validation,'errors':blend_errors}
        (a.out/'blend-validation.json').write_text(json.dumps(blend_validation,indent=2),encoding='utf-8')
    errors=[]
    for row in rows.values():
        if row['errors']:
            detail=json.loads(gzip.decompress((a.source/row['file']).read_bytes()))
            errors.append({'package':row['package'],'count':row['errors'],'file':'records/'+row['file'],'details':detail['errors']})
    report={**summary,'assets':catalog,'errors':errors,
        'provenance':manifest,'validation':validation,'raw_additive':additive_report,'typed_blendspaces':blend_report,'native_replay_pose_reconstruction':False}
    (a.out/'catalog.json').write_text(json.dumps(report,separators=(',',':')),encoding='utf-8')
    (a.out/'validation.json').write_text(json.dumps(validation,indent=2),encoding='utf-8')
    publish_viewer(a.out)
    concise={k:v for k,v in report.items() if k not in ['assets','errors','provenance','validation','raw_additive','typed_blendspaces']}
    if additive_report:concise['raw_additive']={**additive_summary,'validation_checks':additive_validation['checks']}
    if blend_report:concise['typed_blendspaces']={**blend_summary,'validation_checks':blend_validation['checks']}
    concise['validation']={k:v for k,v in validation.items() if k!='preview_gaps'}
    print(json.dumps(concise,indent=2))
if __name__=='__main__':main()
