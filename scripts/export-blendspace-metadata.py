"""Recover typed blend-space arrays without flattening static array entries."""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('exporter',ROOT/'scripts/export-installed-animations.py')
exporter=importlib.util.module_from_spec(spec);spec.loader.exec_module(exporter)
KINDS={'BlendSpace','BlendSpace1D','AimOffsetBlendSpace','AimOffsetBlendSpace1D'}

def shape(axes,count,dimensions):
    known=[int(a['GridNum']) if int(a['GridNum'])>0 else None for a in axes[:dimensions]]
    if dimensions==1:
        if count<2 or known[0] not in (None,count-1):return None
        return [count-1]
    pairs=[]
    for x in range(2,count):
        if count%x:continue
        y=count//x
        if y<2:continue
        pair=[x-1,y-1]
        if all(k is None or k==v for k,v in zip(known,pair)):pairs.append(pair)
    return pairs[0] if len(pairs)==1 else None

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('source',type=Path);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--paks',type=Path,default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    p.add_argument('--mappings',type=Path,default=ROOT/'.tools/fmodel/mappings/VALORANT_13.06_zs.usmap');p.add_argument('--aes-key',default=exporter.inspector.asset_map.AES)
    a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    original=json.loads((a.source/'manifest.json').read_text())
    manifest={'source_manifest':original,'source_index_sha256':exporter.inspector.asset_map.digest(a.source/'index.jsonl'),
        'exporter_sha256':exporter.inspector.asset_map.digest(__file__),'serializer_sha256':exporter.inspector.asset_map.digest(ROOT/'scripts/inspect-transcription-assets.py')}
    file=a.out/'manifest.json'
    if file.exists() and json.loads(file.read_text())!=manifest:raise ValueError('Blend metadata provenance changed; use a fresh directory')
    file.write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    reader,handle=exporter.inspector.asset_map.initialize(a)
    archive=lambda:{f.name:{'bytes':f.stat().st_size,'sha256':exporter.inspector.asset_map.digest(f)} for f in a.paks.glob('*.utoc')}
    if archive()!=original['inventory']['archives'] or exporter.inspector.asset_map.digest(a.mappings)!=original['inventory']['mapping_sha256']:raise ValueError('Installed build differs')
    rows=[json.loads(line) for line in (a.source/'index.jsonl').read_text().splitlines()]
    rows=[row for row in rows if any(e['class'] in KINDS for e in row['exports'])]
    results=[]
    with (a.out/'index.jsonl').open('w',encoding='utf-8') as stream:
        for i,row in enumerate(rows,1):
            content={'package':row['package'],'exports':[],'errors':[]}
            try:
                package=reader.LoadPackage(row['package']);package=getattr(package,'__implementation__',package)
                for lazy in package.ExportsLazy:
                    obj=lazy.Value;obj=getattr(obj,'__implementation__',obj);kind=str(obj.GetType().Name).removeprefix('U')
                    if kind not in KINDS:continue
                    axes=exporter.inspector.value_json(obj.BlendParameters)
                    grid=exporter.inspector.value_json(obj.GridSamples)
                    samples=exporter.inspector.value_json(obj.SampleData)
                    dimensions=1 if kind.endswith('1D') else 2
                    if len(axes)<dimensions:raise ValueError('Missing blend axes')
                    dimensions_grid=shape(axes,len(grid),dimensions)
                    record={'object_path':str(obj.GetPathName()),'export_class':kind,'metadata_kind':'typed_blendspace_arrays',
                        'axes':axes,'samples':samples,'grid':grid,'grid_divisions':dimensions_grid,
                        'grid_shape_binding':'serialized_or_unique_grid_count' if dimensions_grid else 'unbound_grid_shape',
                        'duration_seconds':float(obj.AnimLength),'properties':{k:exporter.inspector.value_json(v) for k,v in exporter.inspector.asset_map.properties(obj).items()
                            if k not in ('BlendParameters','SampleData','GridSamples')},
                        'native_graph_execution':False}
                    content['exports'].append(record)
            except Exception as error:content['errors'].append({'error':str(error).splitlines()[0]})
            item={'package':row['package'],**exporter.write_record(a.out,row['package'],content),'source_record_sha256':row['sha256'],
                'errors':len(content['errors']),'exports':[{'object_path':e['object_path'],'class':e['export_class']} for e in content['exports']]}
            results.append(item);stream.write(json.dumps(item)+'\n')
            if i%100==0:stream.flush();print(f'{i}/{len(rows)} blend-space packages',flush=True)
    if archive()!=original['inventory']['archives']:raise ValueError('Archives changed during export')
    summary={'schema_version':1,'processed_packages':len(results),'discovered_packages':len(rows),'complete_inspection':True,
        'export_errors':sum(r['errors'] for r in results),'blendspaces_decoded':sum(len(r['exports']) for r in results),'native_graph_execution':False}
    (a.out/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8');print(json.dumps(summary,indent=2))

if __name__=='__main__':main()
