"""Decode installed behavior packages, retaining bytecode and dependency gaps.

Uses the complete header inventory, never replay references. One gzip record per
package keeps the scan resumable and avoids a giant in-memory inspection report.
"""
from __future__ import annotations
import argparse
from collections import Counter
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('asset_inspector', ROOT/'scripts/inspect-transcription-assets.py')
inspector = importlib.util.module_from_spec(spec); spec.loader.exec_module(inspector)


def portable(value):
    """Preserve Unreal's non-finite sentinels as gaps, never JSON NaN or zero."""
    if isinstance(value, float) and not math.isfinite(value):
        return {'unresolved_numeric': repr(value)}
    if isinstance(value, dict): return {k: portable(v) for k,v in value.items()}
    if isinstance(value, list): return [portable(v) for v in value]
    return value


def inspect(reader, path):
    result = {'package': path, 'exports': [], 'errors': []}
    try:
        pkg = reader.LoadPackage(path); pkg = getattr(pkg, '__implementation__', pkg)
        for i, entry in enumerate(pkg.ExportMap):
            cls = pkg.ResolveObjectIndex(entry.ClassIndex)
            kind = str(cls.Name) if cls else '<unresolved>'
            name = str(pkg.CreateFNameFromMappedName(entry.ObjectName))
            # Bulk render data isn't a Blueprint program. Record omitted exports.
            if kind in ('StaticMesh','SkeletalMesh','AnimSequence','Texture2D','TextureCube','SoundWave'):
                result.setdefault('omitted_bulk_exports', []).append({'name': name, 'class': kind}); continue
            try:
                obj = pkg.ExportsLazy[i].Value
                obj = getattr(obj, '__implementation__', obj)
                row = {'name': name, 'type': str(obj.GetType().Name), 'export_class': kind,
                       'object_path': str(obj.GetPathName()),
                       'properties': {k: inspector.value_json(v) for k, v in inspector.asset_map.properties(obj).items()}}
                for field in ('SuperStruct','ClassDefaultObject','DefaultObject','ScriptBytecode','FunctionFlags',
                              'ChildProperties','EventGraphFunction','EventGraphCallOffset',
                              'AnimBlueprintFunctionData','BakedStateMachines','OrderedSavedPoseIndices',
                              'AnimNodeProperties','TargetSkeleton'):
                    if hasattr(obj, field): row[field] = inspector.value_json(getattr(obj, field))
                result['exports'].append(row)
            except Exception as error:
                result['errors'].append({'export': name, 'error': str(error).splitlines()[0]})
    except Exception as error:
        result['errors'].append({'error': str(error).splitlines()[0]})
    return portable(result)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('inventory', type=Path)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--paks', type=Path, default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    p.add_argument('--mappings', type=Path, default=ROOT/'.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    p.add_argument('--aes-key', default=inspector.asset_map.AES)
    p.add_argument('--limit', type=int)
    a = p.parse_args(); a.out.mkdir(parents=True, exist_ok=True)
    summary = json.loads((a.inventory/'summary.json').read_text(encoding='utf-8'))
    if not summary['complete_inventory']: raise ValueError('Finish the header inventory first')
    fingerprint = {'inventory': summary['fingerprint'], 'inspector_sha256': inspector.asset_map.digest(__file__),
                   'schema_version': 3,
                   'serializer_sha256': inspector.asset_map.digest(ROOT/'scripts/inspect-transcription-assets.py')}
    manifest = a.out/'manifest.json'
    if manifest.exists() and json.loads(manifest.read_text(encoding='utf-8')) != fingerprint:
        raise ValueError('Inspection provenance changed; use a fresh directory')
    manifest.write_text(json.dumps(fingerprint, indent=2), encoding='utf-8')
    reader, handle = inspector.asset_map.initialize(a); reader.ReadScriptData = True
    archive = lambda: {f.name: {'bytes':f.stat().st_size,'sha256':inspector.asset_map.digest(f)} for f in a.paks.glob('*.utoc')}
    if archive() != summary['fingerprint']['archives'] or inspector.asset_map.digest(a.mappings) != summary['fingerprint']['mapping_sha256']:
        raise ValueError('Inventory and installed build/mapping differ')
    rows = [json.loads(line) for line in (a.inventory/'headers.jsonl').read_text(encoding='utf-8').splitlines()]
    candidates = [r['package'] for r in rows if r['generated_classes'] or r['classes'].get('Function')]
    # Logic-bearing packages first; native-only defaults follow, also independent
    # of which classes happened to occur in the replay corpus.
    executable = {r['package'] for r in rows if r['classes'].get('Function') or r['classes'].get('AnimBlueprintGeneratedClass')}
    def priority(path):
        prefixes=('ShooterGame/Content/Characters/_Core/','ShooterGame/Content/Characters/Global/',
                  'ShooterGame/Content/Characters/','ShooterGame/Content/Equippables/_Core/')
        group=next((i for i,prefix in enumerate(prefixes) if path.startswith(prefix)),len(prefixes))
        return path not in executable,group,path.casefold()
    candidates.sort(key=priority)
    index_path = a.out/'index.jsonl'; done = {}
    if index_path.exists():
        for line in index_path.read_text(encoding='utf-8').splitlines():
            r=json.loads(line); target=a.out/r['file']
            if target.is_file() and inspector.asset_map.digest(target)==r['sha256']: done[r['package']]=r
    pending=[path for path in candidates if path not in done]
    if a.limit is not None: pending=pending[:a.limit]
    started=time.monotonic()
    with index_path.open('a', encoding='utf-8') as stream:
        for i,path in enumerate(pending,1):
            data=inspect(reader,path)
            name=hashlib.sha256(path.casefold().encode()).hexdigest()+'.json.gz'
            target=a.out/name
            target.write_bytes(gzip.compress(json.dumps(data,separators=(',',':'),allow_nan=False).encode(),mtime=0))
            row={'package':path,'file':name,'sha256':inspector.asset_map.digest(target),'errors':len(data['errors']),
                 'functions':sum(e['export_class']=='Function' for e in data['exports']),
                 'exports':len(data['exports'])}
            stream.write(json.dumps(row)+'\n');done[path]=row
            if i%100==0:
                stream.flush();print(f'{len(done)}/{len(candidates)} packages; {i/(time.monotonic()-started):.1f}/s',flush=True)
    if archive()!=summary['fingerprint']['archives']:raise ValueError('Archives changed during inspection')
    report={'schema_version':1,'fingerprint':fingerprint,'discovered_behavior_packages':len(candidates),
        'logic_bearing_packages':len(executable),'decoded_packages':len(done),
        'complete_inspection':len(done)==len(candidates),'functions':sum(x['functions'] for x in done.values()),
        'export_errors':sum(x['errors'] for x in done.values()),'native_behavior_implemented':False}
    (a.out/'summary.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='fingerprint'},indent=2))


if __name__=='__main__':main()
