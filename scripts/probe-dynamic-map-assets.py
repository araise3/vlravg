"""Read-only dynamic map actor/component inspection into a fresh evidence file."""
import argparse
import importlib.util
import json
from pathlib import Path
import re

import numpy as np

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('dynamic_inspector',ROOT/'scripts/inspect-transcription-assets.py')
inspector=importlib.util.module_from_spec(spec);spec.loader.exec_module(inspector)
CLASSES={
    '/Game/Interactable/WindowShield.WindowShield_C',
    '/Game/Maps/Jam/Drawbridge.Drawbridge_C',
    '/Game/Interactable/WallPlates/RespawningWallPlate.RespawningWallPlate_C',
    '/Game/Interactable/RespawningDestructible.RespawningDestructible_C',
}


def object_path(value):
    if isinstance(value,dict):value=value.get('reference','')
    if not isinstance(value,str):return None
    match=re.search(r"(/Game/[^']+)",value)
    return match[1].replace(':','.') if match else None


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--paks',type=Path,default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    p.add_argument('--mappings',type=Path,default=ROOT/'.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    p.add_argument('--aes-key',default=inspector.asset_map.AES)
    a=p.parse_args()
    if a.out.exists():raise ValueError('Evidence output already exists; use a new file')
    archive=lambda:{f.name:{'bytes':f.stat().st_size,'sha256':inspector.asset_map.digest(f)} for f in a.paks.glob('*.utoc')}
    before=archive()
    reader,handle=inspector.asset_map.initialize(a);reader.ReadScriptData=True
    records=[];streaming=[]
    for map_code in ['Ascent','Jam']:
        exports=reader.LoadPackage(f'ShooterGame/Content/Maps/{map_code}/{map_code}.umap').GetExports()
        world=next(x for x in exports if str(x.GetType().Name)=='UWorld')
        for reference in world.StreamingLevels:
            level=inspector.asset_map.load(reference)
            if level is None:continue
            props=inspector.asset_map.properties(level)
            streaming.append({'map_path':f'/Game/Maps/{map_code}/{map_code}','class':str(level.GetType().Name),
                              'asset':str(props.get('WorldAsset','')),'properties':{k:inspector.value_json(v) for k,v in props.items()}})
    for path in ('ShooterGame/Content/Maps/Ascent/Ascent_Gameplay_Dynamic.umap','ShooterGame/Content/Maps/Jam/Jam_Gameplay.umap'):
        pkg=reader.LoadPackage(path);pkg=getattr(pkg,'__implementation__',pkg)
        exports=[]
        for i,entry in enumerate(pkg.ExportMap):
            cls=pkg.ResolveObjectIndex(entry.ClassIndex)
            name=str(pkg.CreateFNameFromMappedName(entry.ObjectName))
            class_path=str(cls.GetPathName()) if cls else None
            # Keep serialized metadata rather than guess which actor names block vision.
            try:
                obj=pkg.ExportsLazy[i].Value;obj=getattr(obj,'__implementation__',obj)
                if str(obj.GetType().Name) in ('UModel','UPolys','UWorld','ULevel','UModelComponent'):
                    continue
                exports.append({'name':name,'class_path':class_path,'type':str(obj.GetType().Name),
                                'object_path':str(obj.GetPathName()),'outer_path':str(obj.Outer),
                                'template_path':str(pkg.ResolveObjectIndex(entry.TemplateIndex)),
                                'properties':{k:inspector.value_json(v) for k,v in inspector.asset_map.properties(obj).items()}})
            except Exception as error:
                exports.append({'name':name,'class_path':class_path,'error':str(error).splitlines()[0]})
        records.append({'package':path,'exports':exports})
    if before!=archive():raise ValueError('Installed archive changed while reading dynamic map actors')
    # The full behavior source already pins these class programs to the same
    # installed archive/mapping. Reuse its immutable records rather than infer
    # behavior from an instance name.
    behavior=ROOT/'.local/replay-transcripts/asset-research/installed-behavior-source-v5'
    import gzip
    receipts={r['package']:r for r in map(json.loads,(behavior/'index.jsonl').read_text().splitlines())}
    class_records=[]
    for class_path in sorted(CLASSES):
        package='ShooterGame/Content/'+class_path.split('.',1)[0].removeprefix('/Game/')+'.uasset'
        receipt=receipts[package]
        source=behavior/receipt['file']
        if inspector.asset_map.digest(source)!=receipt['sha256']:raise ValueError('Behavior source receipt changed')
        class_records.append({'receipt':receipt,'data':json.loads(gzip.decompress(source.read_bytes()))})
    behavior_fingerprint=json.loads((behavior/'manifest.json').read_text())
    if behavior_fingerprint['inventory']['archives']!=before:raise ValueError('Map and class source archives differ')
    objects={object_path(e['object_path']):e for record in class_records for e in record['data']['exports']}
    objects.update({object_path(e['object_path']):e for p in records for e in p['exports'] if e.get('object_path')})
    resolved={}
    def effective(e,seen=None):
        path=object_path(e['object_path'])
        if path in resolved:return resolved[path]
        seen=set() if seen is None else seen
        if path in seen:raise ValueError('Cyclic serialized component template')
        seen.add(path)
        parent=objects.get(object_path(e.get('template_path')))
        values=dict(effective(parent,seen)) if parent else {}
        values.update(e['properties']);resolved[path]=values
        return values
    from CUE4Parse.UE4.Objects.Core.Math import FVector,FRotator,FTransform
    selected=[];meshes={}
    for p in records:
        for actor in p['exports']:
            if actor.get('class_path') not in CLASSES or actor.get('type')!='AActor':continue
            path=object_path(actor['object_path'])
            components=[]
            for e in p['exports']:
                if not object_path(e.get('object_path','')) or not object_path(e['object_path']).startswith(path+'.'):continue
                if e['class_path'] not in ['/Script/Engine.SceneComponent','/Script/Engine.StaticMeshComponent']:continue
                props=effective(e)
                # Record the exact converter transform separately from native
                # activation/clock behavior, which is not verified here.
                xyz=lambda name,default:FVector(*[float(props.get(name,{}).get(k,default)) for k in 'XYZ'])
                rot=props.get('RelativeRotation',{})
                matrix=inspector.asset_map.affine(FTransform(FRotator(*[float(rot.get(k,0)) for k in ['Pitch','Yaw','Roll']]),xyz('RelativeLocation',0),xyz('RelativeScale3D',1)),FVector)
                component={'object_path':e['object_path'],'class_path':e['class_path'],'effective_properties':props,
                           'template_path':e['template_path'],'relative_matrix_cm':matrix.tolist(),
                           'transform_defaults':'Unreal SceneComponent identity for omitted serialized transform fields'}
                components.append(component)
                mesh_path=object_path(props.get('StaticMesh'))
                if not mesh_path or mesh_path in meshes:continue
                package='ShooterGame/Content/'+mesh_path.split('.',1)[0].removeprefix('/Game/')+'.uasset'
                exports=reader.LoadPackage(package).GetExports()
                mesh=next(x for x in exports if str(x.GetType().Name)=='UStaticMesh')
                lod=mesh.RenderData.LODs[0]
                vertices=[[float(v.X),float(v.Y),float(v.Z)] for v in lod.PositionVertexBuffer.Verts]
                modes=[inspector.asset_map.material_mode(m.MaterialInterface,{}) for m in mesh.StaticMaterials]
                meshes[mesh_path]={'package':package,'object_path':mesh_path,'vertices_cm':vertices,
                                  'material_modes':modes,'geometry_kind':'all_serialized_lod0_positions_for_conservative_bounds'}
            selected.append({'package':p['package'],'actor':actor,'components':components})
    if before!=archive():raise ValueError('Installed archive changed while reading dynamic mesh geometry')
    result={'schema_version':3,'mapping_sha256':inspector.asset_map.digest(a.mappings),'archives':before,
            'probe_sha256':inspector.asset_map.digest(__file__),
            'serializer_sha256':inspector.asset_map.digest(ROOT/'scripts/inspect-transcription-assets.py'),
            'behavior_source_manifest_sha256':inspector.asset_map.digest(behavior/'manifest.json'),
            'packages':records,'streaming_levels':streaming,'class_records':class_records,'selected_actors':selected,'meshes':meshes,
            'native_visual_fidelity_verified':False}
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'packages':len(records),'exports':sum(len(x['exports']) for x in records),'out':str(a.out)}))


if __name__=='__main__':main()
