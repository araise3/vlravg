"""Decompress installed animation tracks, independently of replay examples.

Retains every key and explicit skeleton, additive and retarget metadata. Does not
claim that an asset reference establishes its native playback/blending state.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor
import threading

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('animation_inspector',ROOT/'scripts/inspect-transcription-assets.py')
inspector=importlib.util.module_from_spec(spec);spec.loader.exec_module(inspector)
KINDS={'AnimSequence','AnimMontage','AnimComposite','BlendSpace','BlendSpace1D','AimOffsetBlendSpace','AimOffsetBlendSpace1D','Skeleton'}

def vec(v):return [float(v.X),float(v.Y),float(v.Z)]
def quat(v):return [float(v.X),float(v.Y),float(v.Z),float(v.W)]
def transform(v):return {'translation':vec(v.Translation),'rotation':quat(v.Rotation),'scale':vec(v.Scale3D)}
def check_finite(v):
    if isinstance(v,float) and not math.isfinite(v):raise ValueError('Non-finite animation value')
    if isinstance(v,dict):
        for child in v.values():check_finite(child)
    if isinstance(v,list):
        for child in v:check_finite(child)
def write_record(out,name,value):
    check_finite(value)
    file=hashlib.sha256(name.casefold().encode()).hexdigest()+'.json.gz'
    p=out/file;p.write_bytes(gzip.compress(json.dumps(value,separators=(',',':'),allow_nan=False).encode(),mtime=0))
    return {'file':file,'sha256':inspector.asset_map.digest(p)}
def skeleton_json(skeleton):
    r=skeleton.ReferenceSkeleton
    if len(r.FinalRefBoneInfo)!=len(r.FinalRefBonePose):raise ValueError('Skeleton bone/pose count differs')
    return {'object_path':str(skeleton.GetPathName()),'bones':[{'name':str(b.Name),'parent':int(b.ParentIndex),'rest':transform(p)}
        for b,p in zip(r.FinalRefBoneInfo,r.FinalRefBonePose)],'translation_retargeting':[str(v) for v in skeleton.BoneTree]}

def sequence_json(obj,converter):
    from CUE4Parse.UE4.Objects.Core.Math import FQuat,FVector
    converted=converter.ConvertAnims(obj)
    if len(converted.Sequences)!=1:raise ValueError('Sequence converted into unexpected number of clips')
    seq=converted.Sequences[0];skel=getattr(converted.Skeleton,'__implementation__',converted.Skeleton)
    skeleton=skeleton_json(skel)
    if len(seq.Tracks)!=len(skeleton['bones']):raise ValueError('Converted track/skeleton count differs')
    base=[transform(p) for p in seq.RetargetBasePose] if seq.RetargetBasePose is not None else [b['rest'] for b in skeleton['bones']]
    if len(base)!=len(seq.Tracks):raise ValueError('Retarget basis/track count differs')
    tracks=[]
    for track in seq.Tracks:
        tracks.append({'rotation':[quat(q) for q in track.KeyQuat],'translation':[vec(v) for v in track.KeyPos],
            'scale':[vec(v) for v in track.KeyScale],'times':[float(t) for t in track.KeyTime],
            'rotation_times':[float(t) for t in track.KeyQuatTime],'translation_times':[float(t) for t in track.KeyPosTime],
            'scale_times':[float(t) for t in track.KeyScaleTime]})
    reference=[]
    # Independent reference outputs from the installed .NET converter API.
    # This checks JS track sampling, not native animation graph execution.
    for bone in sorted({0,min(5,len(tracks)-1),len(tracks)-1}):
        for frame in (0.,max(0.,float(seq.NumFrames-1)*.371)):
            b=base[bone]
            rotation,translation,scale=seq.Tracks[bone].GetBoneTransform(frame,seq.NumFrames,
                FQuat(*b['rotation']),FVector(*b['translation']),FVector(*b['scale']))
            reference.append({'bone':bone,'frame':frame,'rotation':quat(rotation),'translation':vec(translation),'scale':vec(scale)})
    return {'object_path':str(obj.GetPathName()),'skeleton':skeleton['object_path'],'frames':int(seq.NumFrames),
        'frames_per_second':float(seq.FramesPerSecond),'duration_seconds':float(obj.SequenceLength),
        'rate_scale':float(obj.RateScale),'additive_type':str(obj.AdditiveAnimType),'converted_is_additive':bool(seq.IsAdditive),
        'interpolation':str(obj.Interpolation),'base_pose':base,'tracks':tracks,'reference_samples':reference,
        'pose_kind':'cue_converted_tracks','native_graph_execution':False},skeleton

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('inventory',type=Path);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--paks',type=Path,default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    p.add_argument('--mappings',type=Path,default=ROOT/'.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    p.add_argument('--aes-key',default=inspector.asset_map.AES);p.add_argument('--limit',type=int)
    p.add_argument('--jobs',type=int,default=4)
    a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    summary=json.loads((a.inventory/'summary.json').read_text(encoding='utf-8'))
    if not summary['complete_inventory']:raise ValueError('Complete installed inventory required')
    fingerprint={'inventory':summary['fingerprint'],'exporter_sha256':inspector.asset_map.digest(__file__),
        'serializer_sha256':inspector.asset_map.digest(ROOT/'scripts/inspect-transcription-assets.py'),
        'assemblies':{n:inspector.asset_map.digest(ROOT/'.tools/fmodel/libs'/n) for n in ['CUE4Parse.dll','CUE4Parse-Conversion.dll','CUE4Parse-Natives.dll']}}
    manifest=a.out/'manifest.json'
    if manifest.exists() and json.loads(manifest.read_text())!=fingerprint:raise ValueError('Animation provenance changed; use a fresh directory')
    manifest.write_text(json.dumps(fingerprint,indent=2),encoding='utf-8')
    reader,handle=inspector.asset_map.initialize(a)
    archive=lambda:{f.name:{'bytes':f.stat().st_size,'sha256':inspector.asset_map.digest(f)} for f in a.paks.glob('*.utoc')}
    if archive()!=summary['fingerprint']['archives'] or inspector.asset_map.digest(a.mappings)!=summary['fingerprint']['mapping_sha256']:raise ValueError('Installed build differs from inventory')
    import clr
    clr.AddReference('CUE4Parse-Conversion')
    from CUE4Parse_Conversion.Animations import AnimConverter
    headers=[json.loads(l) for l in (a.inventory/'headers.jsonl').read_text().splitlines()]
    packages=[h['package'] for h in headers if KINDS.intersection(h['classes'])]
    packages.sort(key=lambda s:(not '/Characters/_Core/' in s,not 'Crouch' in s,s))
    index=a.out/'index.jsonl';done={}
    if index.exists():
        for line in index.read_text().splitlines():
            r=json.loads(line)
            if (a.out/r['file']).is_file() and inspector.asset_map.digest(a.out/r['file'])==r['sha256']:done[r['package']]=r
    pending=[p for p in packages if p not in done]
    if a.limit is not None:pending=pending[:a.limit]
    started=time.monotonic();skeleton_cache={};skeleton_lock=threading.Lock()
    def process(package):
            data={'package':package,'exports':[],'errors':[]}
            try:
                pkg=reader.LoadPackage(package);pkg=getattr(pkg,'__implementation__',pkg)
                for n,entry in enumerate(pkg.ExportMap):
                    kind=str(pkg.ResolveObjectIndex(entry.ClassIndex).Name)
                    if kind not in KINDS:continue
                    try:
                        obj=pkg.ExportsLazy[n].Value;obj=getattr(obj,'__implementation__',obj)
                        if kind=='AnimSequence':
                            record,skeleton=sequence_json(obj,AnimConverter)
                            with skeleton_lock:
                                if skeleton['object_path'] not in skeleton_cache:skeleton_cache[skeleton['object_path']]=write_record(a.out,skeleton['object_path'],skeleton)
                                skeleton_ref=skeleton_cache[skeleton['object_path']]
                            record.update(export_class=kind,skeleton_record=skeleton_ref)
                        elif kind=='Skeleton':record={**skeleton_json(obj),'export_class':kind}
                        else:
                            record={'object_path':str(obj.GetPathName()),'export_class':kind,
                                'properties':{k:inspector.value_json(v) for k,v in inspector.asset_map.properties(obj).items()}}
                            for field in ['SlotAnimTracks','CompositeSections','SequenceLength','RateScale','Notifies']:
                                if hasattr(obj,field):record[field]=inspector.value_json(getattr(obj,field))
                        check_finite(record)
                        data['exports'].append(record)
                    except Exception as error:data['errors'].append({'class':kind,'error':str(error).splitlines()[0]})
            except Exception as error:data['errors'].append({'error':str(error).splitlines()[0]})
            item={'package':package,**write_record(a.out,package,data),'errors':len(data['errors']),
                'exports':[{'object_path':e['object_path'],'class':e['export_class'],
                    **({k:e[k] for k in ['frames','duration_seconds','additive_type','skeleton']} if e['export_class']=='AnimSequence' else {})} for e in data['exports']]}
            return item
    with index.open('a',encoding='utf-8') as stream,ThreadPoolExecutor(max_workers=a.jobs) as pool:
        for i,item in enumerate(pool.map(process,pending),1):
            done[item['package']]=item;stream.write(json.dumps(item)+'\n')
            if i%50==0:stream.flush();print(f'{len(done)}/{len(packages)} animation packages; {i/(time.monotonic()-started):.1f}/s',flush=True)
    if archive()!=summary['fingerprint']['archives']:raise ValueError('Archives changed during animation export')
    result={'schema_version':1,'discovered_packages':len(packages),'processed_packages':len(done),'complete_inspection':len(done)==len(packages),
        'export_errors':sum(r['errors'] for r in done.values()),'sequence_tracks_decoded':sum(e['class']=='AnimSequence' for r in done.values() for e in r['exports']),
        'native_animation_graph_execution':False}
    (a.out/'summary.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))

if __name__=='__main__':main()
