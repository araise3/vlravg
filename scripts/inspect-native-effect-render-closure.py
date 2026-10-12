"""Follow serialized visibility FXC/particle links with full object identities.

This is a bounded render-reference closure, not native effect execution.
Particle age, emitter activation, LOD selection and achieved opacity stay null.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re

from replay_asset_model import reference_package

ROOT = Path(__file__).resolve().parent.parent
WIDGET = 'ShooterGame/Content/UI/InGame/HUD/BlindsDrivenMaterialOverlay.uasset'
SMOKE = 'ShooterGame/Content/Characters/Global/Smoke/GameObject_NewSmokeZone_Parent.uasset'
WIDGET_OWNERS = ('ShooterGame/Content/UI/InGame/HUD/FirstPersonHUD.uasset',
    'ShooterGame/Content/UI/InGame/HUD/BroadcastHUD.uasset')
MATERIALS = {'Material', 'MaterialInstanceConstant', 'MaterialInstanceDynamic'}
PARTICLES = {'ParticleSystem', 'NiagaraSystem'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def walk(value, path=()):
    if isinstance(value, dict):
        yield path, value
        for key, child in value.items():
            yield from walk(child, path + (key,))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, path + (index,))


def identity(reference):
    match = re.fullmatch(r"([^']+)'([^']+)'", reference)
    return (match[1], match[2]) if match else (None, None)


def reference_edges(package):
    result = []
    for export in package['exports']:
        for path, value in walk(export):
            ref = value.get('reference', '')
            kind, object_path = identity(ref)
            target = reference_package(value)
            if not target:
                continue
            name = target.rsplit('/', 1)[-1]
            if target == package['package']:
                action = 'local_object_reference'
            elif kind in MATERIALS:
                action = 'material_candidate'
            elif kind in PARTICLES or kind and kind.startswith('Curve'):
                action = 'follow_render_metadata'
            elif 'SuperStruct' in path or kind == 'WidgetBlueprintGeneratedClass' or name.startswith(('FXC_', 'Comp_')):
                action = 'follow_render_metadata'
            elif kind in ('StaticMesh', 'SkeletalMesh', 'Texture2D', 'TextureCube', 'NiagaraEmitter'):
                action = 'unexpanded_render_input'
            else:
                action = 'outside_selected_render_policy'
            result.append({'source_export': export.get('object_path', export['name']),
                'property_path': list(path), 'reference': ref, 'target_kind': kind,
                'target_object_path': object_path, 'target_package': target, 'action': action})
    return result


def summarize_particles(package):
    """Resolve system/emitter/LOD/module links by full path, never short name."""
    exports = {e['object_path']: e for e in package['exports']}
    if len(exports) != len(package['exports']):
        raise ValueError('Duplicate full particle export identity')

    def resolve(ref, expected=None):
        kind, path = identity(ref.get('reference', '')) if isinstance(ref, dict) else (None, None)
        if path is None or path not in exports:
            raise ValueError('Particle local object reference is unresolved: ' + str(ref))
        obj = exports[path]
        if expected is not None and obj['export_class'] != expected:
            raise ValueError('Particle local object has unexpected class')
        return obj

    def module(ref):
        obj = resolve(ref)
        return {'object_path': obj['object_path'], 'export_class': obj['export_class'],
            'serialized_properties': obj['properties'], 'native_module_evaluated': False}

    systems = []
    for system in package['exports']:
        if system['export_class'] != 'ParticleSystem':
            continue
        emitters = []
        for emitter_index, ref in enumerate(system['properties'].get('Emitters', [])):
            emitter = resolve(ref, 'ParticleSpriteEmitter')
            lods = []
            for lod_index, lod_ref in enumerate(emitter['properties'].get('LODLevels', [])):
                lod = resolve(lod_ref, 'ParticleLODLevel')
                properties = lod['properties']
                required = module(properties['RequiredModule'])
                modules = [module(r) for r in properties.get('Modules', [])]
                for key in ('SpawnModule', 'TypeDataModule'):
                    if properties.get(key, {}).get('reference') not in (None, '0'):
                        modules.append(module(properties[key]))
                required_props = required['serialized_properties']
                lods.append({'serialized_lod_index': lod_index, 'object_path': lod['object_path'],
                    'serialized_properties': properties, 'required_module': required,
                    'material_reference': required_props.get('Material'), 'modules': modules,
                    'clock_inputs': {k: v for k, v in required_props.items()
                        if 'Time' in k or 'Delay' in k or 'Duration' in k or 'Loop' in k or 'Kill' in k},
                    'lifetime_modules': [m for m in modules if m['export_class'] == 'ParticleModuleLifetime'],
                    'dynamic_parameter_modules': [m for m in modules if m['export_class'] == 'ParticleModuleParameterDynamic'],
                    'native_lod_selected': False, 'native_emitter_time_seconds': None,
                    'native_particle_age_seconds': None, 'achieved_opacity': None})
            emitters.append({'serialized_emitter_index': emitter_index, 'object_path': emitter['object_path'],
                'serialized_properties': emitter['properties'], 'emitter_name': emitter['properties'].get('EmitterName'),
                'lods': lods, 'native_activation_time_ms': None})
        systems.append({'object_path': system['object_path'], 'serialized_properties': system['properties'],
            'emitters': emitters, 'native_system_activated': False, 'native_shader_opacity_verified': False})
    return systems


def inspect(args):
    material_raw = args.materials.read_bytes()
    material_report = json.loads(material_raw)
    inventory = json.loads((args.source / 'manifest.json').read_bytes())['inventory']
    if material_report['mapping_sha256'] != inventory['mapping_sha256'] or material_report['archives'] != inventory['archives']:
        raise ValueError('Render root/source provenance differs')
    index = {r['package']: r for r in map(json.loads, (args.source / 'index.jsonl').read_text().splitlines())}
    roots = sorted(set(material_report['blueprint_sources']) | {WIDGET, SMOKE})
    for path, receipt in material_report['blueprint_sources'].items():
        if receipt != {k: index[path][k] for k in ('file', 'sha256')}:
            raise ValueError('Render root receipt differs')
    spec = importlib.util.spec_from_file_location('render_closure_inspector', ROOT / 'scripts/inspect-transcription-assets.py')
    inspector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inspector)
    original = inspector.value_json

    def preserve(value, depth=0):
        value = getattr(value, '__implementation__', value)
        if value is not None and hasattr(value, 'GetType'):
            name = str(value.GetType().Name)
            if depth > 24:
                raise ValueError('Render metadata exceeds decoder depth')
            if name == 'UScriptMap':
                return {'serialized_map': [{'key': preserve(k.Value, depth+1),
                    'value': preserve(value.Properties[k].Value, depth+1)} for k in value.Properties.Keys]}
            if name.endswith('Property') and str(value.GetType().Namespace).endswith('Objects.Properties') and hasattr(value, 'Value'):
                return preserve(value.Value, depth+1)
        return original(value, depth)

    inspector.value_json = preserve
    actual = lambda: {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p.read_bytes())} for p in args.paks.glob('*.utoc')}
    if digest(args.mappings.read_bytes()) != inventory['mapping_sha256'] or actual() != inventory['archives']:
        raise ValueError('Installed render archives/mappings differ')
    args.aes_key = inspector.asset_map.AES
    reader, handle = inspector.asset_map.initialize(args)
    reader.ReadScriptData = True
    args.out.mkdir(parents=True, exist_ok=True)
    pending, records, missing = list(roots), {}, []
    material_candidates, widget_owners = {}, {}
    # Inspect only the blind-overlay instances in these HUDs. Other HUD
    # widgets are outside the LOS render policy.
    for path in WIDGET_OWNERS:
        receipt = index[path]
        raw = (args.source / receipt['file']).read_bytes()
        package = json.loads(gzip.decompress(raw))
        if digest(raw) != receipt['sha256'] or receipt['errors'] or package.get('errors') or package['package'] != path:
            raise ValueError('HUD widget-owner source receipt differs')
        instances = [e for e in package['exports'] if e['export_class'] == 'BlindsDrivenMaterialOverlay_C']
        widget_owners[path] = {'file': receipt['file'], 'sha256': receipt['sha256'], 'serialized_widget_instances': instances,
            'native_hud_selected': False}
        for instance in instances:
            material = reference_package(instance['properties'].get('BaseMaterial'))
            if material is None:
                raise ValueError('HUD blind-overlay material is absent')
            material_candidates.setdefault(material, set()).add(path)
    while pending:
        path = pending.pop(0)
        if path in records or path in missing:
            continue
        if path in index:
            receipt = index[path]
            raw = (args.source / receipt['file']).read_bytes()
            package = json.loads(gzip.decompress(raw))
            if digest(raw) != receipt['sha256'] or receipt['errors'] or package.get('errors') or package['package'] != path:
                raise ValueError('Cached render metadata receipt differs: ' + path)
            origin = {'kind': 'pinned_behavior_source', 'file': receipt['file'], 'sha256': receipt['sha256']}
        elif path in reader.Files:
            package = {'package': path, 'exports': [], 'errors': []}
            for obj in reader.LoadPackage(path).GetExports():
                props = {k: preserve(v) for k, v in inspector.asset_map.properties(obj).items()}
                row = {'name': str(obj.Name), 'type': str(obj.GetType().Name), 'export_class': str(obj.ExportType),
                    'object_path': str(obj.GetPathName()), 'properties': props,
                    'serialized_property_tags': [{'name': str(p.Name), 'array_index': int(p.ArrayIndex),
                        'array_size': int(p.ArraySize), 'value': preserve(p.Tag.Value)} for p in obj.Properties]}
                for field in ('SuperStruct', 'ScriptBytecode', 'FloatCurve', 'VectorCurves'):
                    if hasattr(obj, field):
                        row[field] = preserve(getattr(obj, field))
                package['exports'].append(row)
            origin = {'kind': 'installed_package', 'package_bytes_sha256': digest(bytes(reader.Files[path].Read()))}
        else:
            missing.append(path)
            continue
        edges = reference_edges(package)
        systems = summarize_particles(package)
        encoded = gzip.compress(json.dumps(package, sort_keys=True, separators=(',', ':'), allow_nan=False).encode(), mtime=0)
        filename = digest(path.encode())[:24] + '.json.gz'
        (args.out / filename).write_bytes(encoded)
        records[path] = {'file': filename, 'sha256': digest(encoded), 'origin': origin,
            'reference_edges': edges, 'particle_systems': systems,
            'unexpanded_bulk_exports': package.get('omitted_bulk_exports', [])}
        for edge in edges:
            if edge['action'] == 'follow_render_metadata':
                pending.append(edge['target_package'])
            elif edge['action'] == 'material_candidate':
                material_candidates.setdefault(edge['target_package'], set()).add(path)
    if actual() != inventory['archives']:
        raise ValueError('Installed archive inventory changed during closure extraction')
    result = {'schema_version': 1, 'kind': 'bounded_serialized_effect_render_closure',
        'generator_sha256': digest(Path(__file__).read_bytes()), 'materials_sha256': digest(material_raw),
        'mapping_sha256': inventory['mapping_sha256'], 'archives': inventory['archives'],
        'decoder_sha256': digest((ROOT / '.tools/fmodel/libs/CUE4Parse.dll').read_bytes()),
        'roots': roots, 'packages': records, 'missing_followed_packages': sorted(missing),
        'widget_owner_sources': widget_owners,
        'material_candidates': {p: sorted(v) for p, v in sorted(material_candidates.items())},
        'policy': 'Follow typed particle systems, curves, Blueprint parents, FXC/component classes and widgets. Record material candidates; leave mesh/texture/Niagara-emitter inputs unexpanded.',
        'native_shader_opacity_verified': False, 'runtime_parameter_binding_verified': False,
        'activation_clock_verified': False, 'native_visibility_verified': False,
        'limitations': ['Serialized emitter delay/lifetime is not an achieved activation clock.',
            'Emitter/LOD/module enablement, team branch, material overrides and particle ages need native evaluation.',
            'Referenced meshes, textures, Niagara emitter programs and native FXC components are not a complete rendered-coverage proof.',
            'Decorative third-person blind particles are not asserted to occlude the first-person view.']}
    (args.out / 'closure.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    systems = [s for r in records.values() for s in r['particle_systems']]
    emitters = [e for s in systems for e in s['emitters']]
    lods = [l for e in emitters for l in e['lods']]
    return {'packages': len(records), 'particle_systems': len(systems), 'emitters': len(emitters),
        'lods': len(lods), 'material_candidates': len(material_candidates), 'missing_followed_packages': len(missing),
        'dynamic_parameter_modules': sum(len(l['dynamic_parameter_modules']) for l in lods),
        'reference_actions': dict(Counter(e['action'] for r in records.values() for e in r['reference_edges'])),
        'native_visibility_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'materials', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--paks', type=Path, default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    parser.add_argument('--mappings', type=Path, default=ROOT / '.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    print(json.dumps(inspect(parser.parse_args()), indent=2))
