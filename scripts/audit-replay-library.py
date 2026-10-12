"""Verify refreshed replay presentations against their preserved local evidence."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
from replay_visibility_inputs import load_inputs
from replay_camera_body import validate_sidecar

ROOT=Path(__file__).resolve().parent.parent

def sha(data):return hashlib.sha256(data).hexdigest()
def read(path):return json.loads(path.read_text(encoding='utf-8'))

def audit(corpus,review,animation_source=None,additive_source=None,blend_source=None):
    library=read(review/'library.json');source=read(corpus)
    expected={r['match_id']:r for r in source['replays'] if r['status']=='validated'}
    assert {r['match_id'] for r in library['replays']}==set(expected),'Library replay set changed'
    behavior=(ROOT/'scripts/replay-behavior-runtime.js').read_text(encoding='utf-8')
    viewer=(ROOT/'scripts/replay-transcription-viewer.js').read_text(encoding='utf-8')
    visibility=(ROOT/'scripts/replay-visibility-runtime.js').read_text(encoding='utf-8')
    effects=(ROOT/'scripts/replay-visibility-effects.js').read_text(encoding='utf-8')
    binding=read(ROOT/'scripts/replay-behavior-asset-bindings.json')
    bound=behavior+'\nReplayBehavior.bindAssetPrograms('+json.dumps(binding).replace('<','\\u003c')+');'
    runtime_sha=sha(behavior.encode());binding_sha=sha((ROOT/'scripts/replay-behavior-asset-bindings.json').read_bytes())
    rows=[]
    for replay in library['replays']:
        assert replay['status']=='ready','Replay build failed'
        directory=(review/replay['viewer']).parent
        html=(directory/'viewer.html').read_text(encoding='utf-8')
        assert '<script>'+bound+'</script>' in html,'Embedded behavior binding differs'
        assert '<script>'+viewer+'</script>' in html,'Embedded viewer differs'
        assert '<script>'+visibility+'</script>' in html,'Embedded visibility evaluator differs'
        assert '<script>'+effects+'</script>' in html,'Embedded vision evidence helper differs'
        match=re.search(r'<script id="replay-bundle" type="application/json">(.*?)</script>',html,re.S)
        assert match,'Replay bundle absent'
        bundle=json.loads(match[1]);data=gzip.decompress(base64.b64decode(bundle['data'],validate=True))
        assert sha(data)==sha((directory/'replay.json').read_bytes()),'Compressed evidence differs'
        inputs,overlays=load_inputs(json.loads(data),directory,expected[replay['match_id']])
        addon=gzip.decompress(base64.b64decode(bundle['visibility_inputs'],validate=True))
        assert json.loads(addon)==inputs,'Visibility inputs differ from verified sidecars'
        assert sha(addon)==bundle['visibility_inputs_sha256'],'Visibility input hash differs'
        assert bundle['visibility_effects_sha256']==sha(effects.encode()),'Vision evidence code hash differs'
        assert [gzip.decompress(base64.b64decode(raw,validate=True)) for raw in bundle['visibility_overlays']]==overlays,'Overlay BVHs differ'
        if inputs.get('camera_body'):
            validate_sidecar(inputs['camera_body'],expected[replay['match_id']],directory/'replay.json')
        text=base64.b64decode(bundle['text'],validate=True).decode('utf-8')
        assert text==(directory/'transcript.txt').read_text(encoding='utf-8'),'Transcript differs'
        receipt=read(directory/'build-receipt.json')['signature']
        assert receipt['replay']==expected[replay['match_id']]['source_sha256'],'Source receipt changed'
        assert receipt['replay-behavior-runtime.js']==runtime_sha,'Receipt runtime differs'
        assert receipt['replay-behavior-asset-bindings.json']==binding_sha,'Receipt binding differs'
        assert receipt['replay-visibility-runtime.js']==sha(visibility.encode()),'Receipt visibility evaluator differs'
        assert receipt['replay-visibility-effects.js']==sha(effects.encode()),'Receipt vision evidence helper differs'
        rows.append({'match_id':replay['match_id'],'evidence_sha256':sha(data),'viewer_sha256':sha(html.encode()),
            'visibility_inputs_sha256':sha(addon),'remote_viewpoint_intervals':len(inputs.get('camera_body',{}).get('remote_viewpoint_intervals',[])),
            'additional_smoke_instances':len(inputs.get('smoke_instances',[])),
            'potential_ability_wall_windows':len(inputs.get('ability_occluders',{}).get('instances',[])),
            'dynamic_map_instances':len(inputs.get('dynamic_occluders',{}).get('instances',[])),
            'static_overlay_triangles':sum(row['triangles'] for row in inputs['geometry_overlays'])})
    coverage=read(review/'behavior-coverage/coverage.json');validation=read(review/'behavior-coverage/validation.json')
    assert coverage['runtime_sha256']==validation['runtime_sha256']==runtime_sha,'Coverage runtime differs'
    assert validation['asset_binding_sha256']==binding_sha,'Coverage asset bindings differ'
    rv=read(review/'behavior-coverage/registry-validation.json')
    assert rv['registry_sha256']==sha((review/'behavior-coverage/compiled-programs.json.gz').read_bytes()),'Compiled registry changed'
    assert rv['runtime_sha256']==runtime_sha,'Registry runtime differs'
    assert rv['checker_sha256']==sha((ROOT/'scripts/check-replay-call-registry.cjs').read_bytes()),'Registry checker changed'
    assert coverage['compiled_registry_sha256']==rv['registry_sha256'],'Registry coverage hash differs'
    assert rv['programs_checked']==coverage['totals']['final_asset_call_closure_programs'],'Registry validation incomplete'
    report={'schema_version':2,'ready_replays':len(rows),'compressed_replay_evidence_matches_exports':True,
        'all_viewers_have_current_frame_runtime':True,'all_viewers_have_current_asset_bindings':True,
        'all_viewers_have_current_visibility_evaluator':True,
        'all_viewers_have_verified_visibility_inputs':True,
        'visibility_inputs_summary':{name:sum(r[name] for r in rows) for name in ('remote_viewpoint_intervals','additional_smoke_instances','potential_ability_wall_windows','dynamic_map_instances')},
        'inventory':coverage['inventory'],'asset_totals':coverage['totals'],'validation':validation,'replays':rows,
        'compiled_registry_validation':rv,
        'native_engine_visual_fidelity_validated':False}
    if animation_source:
        animations=read(review/'animation-assets/catalog.json');av=read(review/'animation-assets/validation.json')
        assert animations['validation']==av,'Animation reports differ'
        assert av['index_sha256']==sha((animation_source/'index.jsonl').read_bytes()),'Animation source index changed'
        assert av['runtime_sha256']==sha((ROOT/'scripts/replay-animation-runtime.js').read_bytes()),'Animation runtime changed'
        assert av['checker_sha256']==sha((ROOT/'scripts/check-replay-animation.cjs').read_bytes()),'Animation checker changed'
        assert av['sequences_checked']==animations['sequence_tracks_decoded'],'Sequence validation incomplete'
        assert av['packages_verified']==animations['processed_packages'],'Package validation incomplete'
        template=(ROOT/'scripts/replay-animation-library-template.html').read_text(encoding='utf-8')
        animation_runtime=(ROOT/'scripts/replay-animation-runtime.js').read_text(encoding='utf-8')
        animation_library=(ROOT/'scripts/replay-animation-library.js').read_text(encoding='utf-8')
        expected_html=template.replace('__ANIMATION_RUNTIME__',animation_runtime).replace('__ANIMATION_LIBRARY__',animation_library)
        assert (review/'animation-assets/index.html').read_text(encoding='utf-8')==expected_html,'Animation presentation differs'
        report['animation']={k:v for k,v in animations.items() if k not in ('assets','errors','provenance','validation','raw_additive','typed_blendspaces')}
        report['animation_validation']={k:v for k,v in av.items() if k!='preview_gaps'}
        if animations.get('raw_additive'):
            assert additive_source,'Raw additive source required for audit'
            ar=animations['raw_additive'];av=read(review/'animation-assets/additive-validation.json')
            assert ar['validation']==av,'Additive reports differ'
            assert av['index_sha256']==sha((additive_source/'index.jsonl').read_bytes()),'Additive source index differs'
            assert av['runtime_sha256']==sha((ROOT/'scripts/replay-animation-runtime.js').read_bytes()),'Additive runtime differs'
            assert av['checker_sha256']==sha((ROOT/'scripts/check-additive-animation.cjs').read_bytes()),'Additive checker differs'
            assert ar['provenance']['exporter_sha256']==sha((ROOT/'scripts/export-additive-animation-tracks.py').read_bytes()),'Additive exporter differs'
            assert av['sequences_checked']==ar['sequence_tracks_decoded'],'Additive sequence validation incomplete'
            assert av['packages_verified']==ar['processed_packages'],'Additive package validation incomplete'
            assert ar['complete_inspection'],'Additive inventory incomplete'
            items={a['object_path']:a for a in animations['assets']}
            for line in (additive_source/'index.jsonl').read_text().splitlines():
                row=json.loads(line)
                assert sha((review/'animation-assets/records/additive'/row['file']).read_bytes())==row['sha256'],'Published raw additive bytes differ'
                for e in row['exports']:
                    item=items[e['object_path']]
                    assert item['source_record_sha256']==row['sha256'],'Catalog raw additive record differs'
                    assert item['converted_source_record_sha256']==row['source_record_sha256'],'Original converted provenance differs'
            report['additive_animation_validation']={k:v for k,v in av.items() if k!='preview_gaps'}
        if animations.get('typed_blendspaces'):
            assert blend_source,'Typed blend-space source required for audit'
            br=animations['typed_blendspaces'];bv=read(review/'animation-assets/blend-validation.json')
            assert br['validation']==bv,'Blend-space reports differ'
            assert bv['index_sha256']==sha((blend_source/'index.jsonl').read_bytes()),'Blend-space source index differs'
            assert bv['runtime_sha256']==sha((ROOT/'scripts/replay-animation-runtime.js').read_bytes()),'Blend-space runtime differs'
            assert bv['checker_sha256']==sha((ROOT/'scripts/check-blendspace-metadata.cjs').read_bytes()),'Blend-space checker differs'
            assert br['provenance']['exporter_sha256']==sha((ROOT/'scripts/export-blendspace-metadata.py').read_bytes()),'Blend-space exporter differs'
            assert bv['blendspaces_checked']==br['blendspaces_decoded'],'Blend-space validation incomplete'
            assert bv['packages_verified']==br['processed_packages'],'Blend-space package validation incomplete'
            assert br['complete_inspection'],'Blend-space inventory incomplete'
            items={a['object_path']:a for a in animations['assets']}
            for line in (blend_source/'index.jsonl').read_text().splitlines():
                row=json.loads(line)
                assert sha((review/'animation-assets/records/blend'/row['file']).read_bytes())==row['sha256'],'Published blend-space bytes differ'
                for e in row['exports']:
                    item=items[e['object_path']]
                    assert item['source_record_sha256']==row['sha256'],'Catalog blend-space record differs'
                    assert item['original_metadata_sha256']==row['source_record_sha256'],'Original blend-space provenance differs'
            report['blendspace_validation']={k:v for k,v in bv.items() if k!='preview_gaps'}
    return report

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('corpus',type=Path);p.add_argument('review',type=Path)
    p.add_argument('--animation-source',type=Path);p.add_argument('--additive-source',type=Path);p.add_argument('--blend-source',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    report=audit(a.corpus,a.review,a.animation_source,a.additive_source,a.blend_source);a.out.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('replays','inventory','asset_totals','validation','animation_validation')},indent=2))

if __name__=='__main__':main()
