"""Export raw additive deltas without the installed converter's base composition.

Changes one deserialized object's additive flag only in memory and restores it
in finally. No installed game bytes are modified. UE compression's omitted
scale channel is an additive identity (zero), not the absolute identity (one).
ACL uses the installed native ABI and a private copy with delta scale defaults.
"""
from __future__ import annotations
import argparse
import ctypes
import gzip
import importlib.util
import json
from pathlib import Path
import time
import threading
from concurrent.futures import ThreadPoolExecutor

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('animation_exporter',ROOT/'scripts/export-installed-animations.py')
exporter=importlib.util.module_from_spec(spec);spec.loader.exec_module(exporter)
neutral={'rotation':[0.,0.,0.,1.],'translation':[0.,0.,0.],'scale':[0.,0.,0.]}

def decode_acl(obj,rig):
    """Call the installed decoder's ABI with its exact managed struct layout."""
    import clr
    from System import Array
    from System.Runtime.InteropServices import Marshal
    from CUE4Parse.UE4.Objects.Core.Math import FTransform,FQuat,FVector
    from CUE4Parse_Conversion.Writers.ActorX.Structs.Animations import CAnimSequence,CAnimTrack
    seq=CAnimSequence(obj,rig)
    if Marshal.SizeOf(clr.GetClrType(FTransform))!=40:raise ValueError('Unverified transform ABI')
    if [Marshal.OffsetOf(clr.GetClrType(FTransform),name).ToInt64() for name in ('Rotation','Translation','Scale3D')]!=[0,16,28]:raise ValueError('Unverified transform field offsets')
    data=getattr(obj.CompressedDataStructure,'__implementation__',obj.CompressedDataStructure)
    compressed=data.GetCompressedTracks();header=compressed.GetTracksHeader();compressed.SetDefaultScale(0)
    count=int(header.NumSamples);mapping=obj.GetTrackMap();tracks=len(mapping)
    if count<1 or count>100000 or tracks<1 or tracks>10000 or count*tracks>20000000:raise ValueError('Invalid ACL dimensions')
    basis=seq.RetargetBasePose if seq.RetargetBasePose is not None else rig.ReferenceSkeleton.FinalRefBonePose
    if len(basis)!=rig.BoneCount:raise ValueError('ACL reference basis/skeleton count differs')
    rest=(ctypes.c_float*(len(basis)*10))(*[v for p in basis for v in exporter.quat(p.Rotation)+exporter.vec(p.Translation)+exporter.vec(p.Scale3D)])
    indices=(ctypes.c_int32*tracks)(*[int(m.BoneTreeIndex) for m in mapping])
    if any(i<0 or i>=len(basis) for i in indices):raise ValueError('Invalid ACL bone map')
    atoms=(ctypes.c_float*(tracks*count*10))()
    library=ctypes.CDLL(str(ROOT/'.tools/fmodel/libs/CUE4Parse-Natives.dll'))
    read=library.nReadACLData;read.argtypes=[ctypes.c_void_p]*4;read.restype=None
    read(compressed.Handle.ToInt64(),ctypes.cast(rest,ctypes.c_void_p),ctypes.cast(indices,ctypes.c_void_p),ctypes.cast(atoms,ctypes.c_void_p))
    # Keep compressed alive until the native read is complete. SetDefaultScale
    # affects this allocated copy, never the serialized byte stream or a file.
    wrap=header.GetIsWrapOptimized()
    for bone in range(rig.BoneCount):
        t=CAnimTrack();seq.Tracks.Add(t);index=int(obj.FindTrackForBoneIndex(bone))
        if index<0:continue
        if index>=tracks:raise ValueError('ACL track index exceeds bone map')
        samples=[list(atoms[(index*count+n)*10:(index*count+n+1)*10]) for n in range(count)]
        if wrap:samples.append(samples[0])
        t.KeyQuat=Array[FQuat]([FQuat(*s[:4]) for s in samples]);t.KeyPos=Array[FVector]([FVector(*s[4:7]) for s in samples]);t.KeyScale=Array[FVector]([FVector(*s[7:]) for s in samples])
    return seq

def export_sequence(obj):
    from CUE4Parse.UE4.Assets.Exports.Animation import EAdditiveAnimationType
    from CUE4Parse.UE4.Objects.Core.Math import FVector,FQuat,FTransform
    from CUE4Parse_Conversion.Animations import AnimConverter
    from CUE4Parse_Conversion.Writers.ActorX.Structs.Animations import FAnimationRuntime,FCompactPose,FPoseBone
    from System import Array
    data=getattr(obj.CompressedDataStructure,'__implementation__',obj.CompressedDataStructure)
    compression=str(data.GetType().Name) if data is not None else 'RawAnimationData'
    if compression not in ('FUECompressedAnimData','FACLCompressedAnimData') and not len(obj.RawAnimationData or []):
        raise ValueError('Raw additive compression path is unverified: '+compression)
    original_type=obj.AdditiveAnimType
    if compression=='FACLCompressedAnimData':
        ok,rig=obj.Skeleton.TryLoad()
        if not ok:raise ValueError('Unresolved additive skeleton')
        rig=getattr(rig,'__implementation__',rig);seq=decode_acl(obj,rig)
    else:
        try:
            obj.AdditiveAnimType=EAdditiveAnimationType.AAT_None
            result=AnimConverter.ConvertAnims(obj)
        finally:obj.AdditiveAnimType=original_type
        seq=result.Sequences[0];rig=getattr(result.Skeleton,'__implementation__',result.Skeleton)
    skeleton=exporter.skeleton_json(rig)
    if len(seq.Tracks)!=len(skeleton['bones']):raise ValueError('Raw track/skeleton count differs')
    omitted_scale=[]
    if compression=='FUECompressedAnimData':
        offsets=data.CompressedScaleOffsets
        per_track=str(data.KeyEncodingFormat)=='AKF_PerTrackCompression'
        for bone,track in enumerate(seq.Tracks):
            index=obj.FindTrackForBoneIndex(bone)
            missing=index<0 or not offsets.IsValid()
            if not missing:
                missing=int(offsets.OffsetData[index])==-1 if per_track else int(offsets.OffsetData[index*2+1])==0
            if missing:
                # Omitted channels carry no delta. Keep their provenance distinct
                # from encoded scale keys, which are retained without adjustment.
                track.KeyScale=Array[FVector]([]);omitted_scale.append(bone)
    tracks=[{'rotation':[exporter.quat(q) for q in t.KeyQuat],'translation':[exporter.vec(v) for v in t.KeyPos],
        'scale':[exporter.vec(v) for v in t.KeyScale],'times':[float(v) for v in t.KeyTime],
        'rotation_times':[float(v) for v in t.KeyQuatTime],'translation_times':[float(v) for v in t.KeyPosTime],
        'scale_times':[float(v) for v in t.KeyScaleTime]} for t in seq.Tracks]
    references=[];composition=[]
    for frame in (0.,max(0.,float(seq.NumFrames-1)*.371)):
        base=FCompactPose(len(tracks));delta=FCompactPose(len(tracks))
        for bone,t in enumerate(seq.Tracks):
            rotation,translation,scale=t.GetBoneTransform(frame,seq.NumFrames,FQuat(0.,0.,0.,1.),FVector(0.),FVector(0.))
            value={'rotation':exporter.quat(rotation),'translation':exporter.vec(translation),'scale':exporter.vec(scale)}
            if bone in {0,min(5,len(tracks)-1),len(tracks)-1}:references.append({'bone':bone,'frame':frame,**value})
            b=FPoseBone();b.Transform=rig.ReferenceSkeleton.FinalRefBonePose[bone];b.ParentIndex=skeleton['bones'][bone]['parent'];b.IsValidKey=True;base.Bones[bone]=b
            d=FPoseBone();d.Transform=FTransform(rotation,translation,scale);d.ParentIndex=b.ParentIndex;d.IsValidKey=True;delta.Bones[bone]=d
        if str(original_type)=='AAT_LocalSpaceBase':FAnimationRuntime.AccumulateLocalSpaceAdditivePoseInternal(base,delta,1.)
        elif str(original_type)=='AAT_RotationOffsetMeshSpace':FAnimationRuntime.AccumulateMeshSpaceRotationAdditiveToLocalPoseInternal(base,delta,1.)
        else:raise ValueError('Unsupported additive type '+str(original_type))
        for bone in sorted({0,min(5,len(tracks)-1),len(tracks)-1}):
            composition.append({'bone':bone,'frame':frame,**exporter.transform(base.Bones[bone].Transform)})
    retarget=[exporter.transform(p) for p in seq.RetargetBasePose] if seq.RetargetBasePose is not None else None
    record={'object_path':str(obj.GetPathName()),'export_class':'AnimSequence','skeleton':skeleton['object_path'],
        'frames':int(seq.NumFrames),'frames_per_second':float(seq.NumFrames)/float(obj.SequenceLength) if float(obj.SequenceLength)>0 else 0.,
        'duration_seconds':float(obj.SequenceLength),'rate_scale':float(obj.RateScale),
        'additive_type':str(original_type),'converted_is_additive':False,'interpolation':str(obj.Interpolation),
        'base_pose':[neutral for _ in tracks],'tracks':tracks,'reference_samples':references,
        'composition_reference_samples':composition,'composition_reference_base':'skeleton_rest',
        'pose_kind':'raw_additive_delta_tracks','compression':compression,'omitted_scale_channels':omitted_scale,
        'reference_pose':{'type':str(obj.RefPoseType),'sequence':exporter.inspector.value_json(obj.RefPoseSeq),'frame_index':int(obj.RefFrameIndex)},
        'retarget_basis':retarget,'notifies':exporter.inspector.value_json(obj.Notifies),
        'native_graph_execution':False,'base_pose_applied':False}
    return record,skeleton

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('source',type=Path);p.add_argument('--out',type=Path,required=True);p.add_argument('--limit',type=int)
    p.add_argument('--jobs',type=int,default=4)
    p.add_argument('--paks',type=Path,default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    p.add_argument('--mappings',type=Path,default=ROOT/'.tools/fmodel/mappings/VALORANT_13.06_zs.usmap');p.add_argument('--aes-key',default=exporter.inspector.asset_map.AES)
    a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    source_manifest=json.loads((a.source/'manifest.json').read_text())
    fingerprint={'source_manifest':source_manifest,'source_index_sha256':exporter.inspector.asset_map.digest(a.source/'index.jsonl'),
        'exporter_sha256':exporter.inspector.asset_map.digest(__file__),'helper_sha256':exporter.inspector.asset_map.digest(ROOT/'scripts/export-installed-animations.py'),
        'pinned_decoder_sources':json.loads((ROOT/'.local/replay-transcripts/asset-research/engine-sources/installed/manifest.json').read_text()),
        'acl_abi_source_sha256':{name:exporter.inspector.asset_map.digest(ROOT/'.local/replay-transcripts/asset-research/engine-sources/installed'/name)
            for name in ['CompressedTracks.cs','AnimBoneCompressionCodec_ACLBase.cs','ACLNative.cs']}}
    manifest=a.out/'manifest.json'
    if manifest.exists() and json.loads(manifest.read_text())!=fingerprint:raise ValueError('Additive provenance changed; use a fresh directory')
    manifest.write_text(json.dumps(fingerprint,indent=2),encoding='utf-8')
    reader,handle=exporter.inspector.asset_map.initialize(a)
    archive=lambda:{f.name:{'bytes':f.stat().st_size,'sha256':exporter.inspector.asset_map.digest(f)} for f in a.paks.glob('*.utoc')}
    if archive()!=source_manifest['inventory']['archives'] or exporter.inspector.asset_map.digest(a.mappings)!=source_manifest['inventory']['mapping_sha256']:raise ValueError('Installed build differs')
    import clr
    clr.AddReference('CUE4Parse-Conversion')
    rows={r['package']:r for line in (a.source/'index.jsonl').read_text().splitlines() if (r:=json.loads(line))}
    packages=[r for r in rows.values() if any(e['class']=='AnimSequence' and e.get('additive_type')!='AAT_None' for e in r['exports'])]
    index=a.out/'index.jsonl';done={}
    if index.exists():
        for line in index.read_text().splitlines():
            row=json.loads(line)
            if (a.out/row['file']).is_file() and exporter.inspector.asset_map.digest(a.out/row['file'])==row['sha256']:done[row['package']]=row
    pending=[r for r in packages if r['package'] not in done]
    if a.limit is not None:pending=pending[:a.limit]
    started=time.monotonic();skeleton_cache={};skeleton_lock=threading.Lock()
    def process(row):
            content={'package':row['package'],'exports':[],'errors':[]}
            try:
                pkg=reader.LoadPackage(row['package']);pkg=getattr(pkg,'__implementation__',pkg)
                for lazy in pkg.ExportsLazy:
                    obj=lazy.Value;obj=getattr(obj,'__implementation__',obj)
                    if str(obj.GetType().Name)!='UAnimSequence' or str(obj.AdditiveAnimType)=='AAT_None':continue
                    try:
                        record,skeleton=export_sequence(obj)
                        path=skeleton['object_path']
                        with skeleton_lock:
                            if path not in skeleton_cache:skeleton_cache[path]=exporter.write_record(a.out,path,skeleton)
                            record['skeleton_record']=skeleton_cache[path]
                        content['exports'].append(record)
                    except Exception as error:content['errors'].append({'object_path':str(obj.GetPathName()),'error':str(error).splitlines()[0]})
            except Exception as error:content['errors'].append({'error':str(error).splitlines()[0]})
            item={'package':row['package'],**exporter.write_record(a.out,row['package'],content),'source_record_sha256':row['sha256'],'errors':len(content['errors']),
                'exports':[{k:e[k] for k in ['object_path','export_class','frames','duration_seconds','additive_type','skeleton']} for e in content['exports']]}
            return item
    with index.open('a',encoding='utf-8') as stream,ThreadPoolExecutor(max_workers=a.jobs) as pool:
        for i,item in enumerate(pool.map(process,pending),1):
            done[item['package']]=item;stream.write(json.dumps(item)+'\n')
            if i%50==0:stream.flush();print(f'{len(done)}/{len(packages)} additive packages; {i/(time.monotonic()-started):.1f}/s',flush=True)
    if archive()!=source_manifest['inventory']['archives']:raise ValueError('Archives changed during export')
    summary={'schema_version':1,'discovered_packages':len(packages),'processed_packages':len(done),'complete_inspection':len(done)==len(packages),
        'sequence_tracks_decoded':sum(len(r['exports']) for r in done.values()),'export_errors':sum(r['errors'] for r in done.values()),'native_graph_execution':False}
    (a.out/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))

if __name__=='__main__':main()
