"""Inventory installed package headers without seeding discovery from replays.

Reads export class names, parent classes, and the shipped asset registry. It does
not deserialize mesh bulk data or execute Blueprint/native game code. The JSONL
cache resumes only against the same archive, mapping and scanner fingerprints.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('asset_inspector', ROOT/'scripts/inspect-transcription-assets.py')
inspector = importlib.util.module_from_spec(spec); spec.loader.exec_module(inspector)


def header(reader, path):
    result = {'package': path, 'classes': {}, 'generated_classes': []}
    try:
        pkg = reader.LoadPackage(path)
        pkg = getattr(pkg, '__implementation__', pkg)
        types = Counter()
        for export in pkg.ExportMap:
            cls = pkg.ResolveObjectIndex(export.ClassIndex)
            name = str(cls.Name) if cls else '<unresolved>'
            types[name] += 1
            if name in ('BlueprintGeneratedClass', 'AnimBlueprintGeneratedClass'):
                parent = pkg.ResolveObjectIndex(export.SuperIndex)
                result['generated_classes'].append({
                    'name': str(pkg.CreateFNameFromMappedName(export.ObjectName)),
                    'type': name, 'parent': parent.GetPathName() if parent else None})
        result['classes'] = dict(types)
        result['export_count'] = int(pkg.ExportMapLength)
        result['deserialized_exports'] = sum(bool(v.IsValueCreated) for v in pkg.ExportsLazy)
    except Exception as error:
        result['error'] = str(error).splitlines()[0]
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--paks', type=Path, default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    p.add_argument('--mappings', type=Path, default=ROOT/'.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    p.add_argument('--aes-key', default=inspector.asset_map.AES)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--limit', type=int, help='Bound this invocation; subsequent runs resume the same inventory')
    a = p.parse_args(); a.out.mkdir(parents=True, exist_ok=True)
    fingerprint = {'scanner_sha256': inspector.asset_map.digest(__file__),
        'mapping_sha256': inspector.asset_map.digest(a.mappings),
        'archives': {f.name: {'bytes': f.stat().st_size, 'sha256': inspector.asset_map.digest(f)} for f in a.paks.glob('*.utoc')}}
    manifest = a.out/'manifest.json'; cache = a.out/'headers.jsonl'
    if manifest.exists():
        if json.loads(manifest.read_text(encoding='utf-8'))['fingerprint'] != fingerprint:
            raise ValueError('Inventory fingerprints changed; choose a fresh output directory')
    elif cache.exists():
        raise ValueError('Cache has no provenance manifest')
    manifest.write_text(json.dumps({'schema_version': 1, 'fingerprint': fingerprint}, indent=2), encoding='utf-8')
    seen = {}
    if cache.exists():
        # A torn last line is repaired before appending; earlier corruption fails.
        lines = cache.read_text(encoding='utf-8').splitlines()
        for i, line in enumerate(lines):
            try: row = json.loads(line)
            except json.JSONDecodeError:
                if i != len(lines)-1: raise
                cache.write_text('\n'.join(lines[:i])+'\n', encoding='utf-8'); break
            seen[row['package'].casefold()] = row
    reader, handle = inspector.asset_map.initialize(a)
    reader.ReadScriptData = False
    mounted = sorted(str(x.Key) for x in reader.Files if str(x.Key).lower().endswith(('.uasset', '.umap')))
    # Registry is useful metadata, but the cooked registry omits most packages.
    from CUE4Parse.UE4.AssetRegistry import FAssetRegistryState
    registry = FAssetRegistryState(reader.CreateReader('ShooterGame/AssetRegistry.bin'))
    registry_rows = [{'package': str(x.PackageName), 'asset': str(x.AssetName), 'class': str(x.AssetClass),
                      'tags': {str(k): str(x.TagsAndValues[k]) for k in x.TagsAndValues.Keys}}
                     for x in registry.PreallocatedAssetDataBuffers]
    (a.out/'registry.json').write_text(json.dumps(registry_rows), encoding='utf-8')
    pending = [path for path in mounted if path.casefold() not in seen]
    if a.limit is not None: pending = pending[:a.limit]
    start = time.monotonic()
    with cache.open('a', encoding='utf-8') as stream:
        for i, path in enumerate(pending, 1):
            row = header(reader, path); seen[path.casefold()] = row
            stream.write(json.dumps(row, allow_nan=False)+'\n')
            if i % 1000 == 0:
                stream.flush(); print(f'{len(seen)}/{len(mounted)} headers; {i/(time.monotonic()-start):.0f}/s', flush=True)
    after = {f.name: {'bytes': f.stat().st_size, 'sha256': inspector.asset_map.digest(f)} for f in a.paks.glob('*.utoc')}
    if after != fingerprint['archives']: raise ValueError('Installed archives changed during inventory')
    classes, selected, errors = Counter(), [], []
    for row in seen.values():
        classes.update(row['classes'])
        if row.get('error'): errors.append({'package': row['package'], 'error': row['error']})
        if row.get('generated_classes') or row['classes'].get('Function'):
            selected.append(row['package'])
    summary = {'schema_version': 1, 'fingerprint': fingerprint, 'mounted_packages': len(mounted),
        'attempted_packages': len(seen), 'successful_headers': len(seen)-len(errors),
        'complete_inventory': len(seen)==len(mounted), 'registry_assets': len(registry_rows),
        'class_counts': dict(classes.most_common()), 'behavior_packages': len(selected), 'errors': errors,
        'discovery_source': 'all_mounted_package_export_headers', 'replay_seeded': False,
        'implemented_behavior_coverage': None}
    (a.out/'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    (a.out/'behavior-packages.json').write_text(json.dumps(sorted(selected), indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in summary.items() if k not in ('fingerprint','class_counts','errors')}, indent=2))


if __name__ == '__main__': main()
