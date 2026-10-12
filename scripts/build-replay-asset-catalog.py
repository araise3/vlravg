"""Add every observed effect/animation's native metadata to the replay model."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from replay_asset_model import reference_package, BASE


def make_catalog(source, agents, model):
    packages = {p['package']: p for p in source['packages']}
    cache = {}
    def inherited(path, seen=None):
        if path in cache:
            return cache[path]
        seen = set() if seen is None else seen
        if path in seen:
            raise ValueError('Asset inheritance cycle')
        seen.add(path)
        pkg = packages.get(path, {})
        cls = next((e for e in pkg.get('exports', []) if e['type']=='UBlueprintGeneratedClass'), {})
        parent = reference_package(cls.get('SuperStruct'))
        values, lineage = inherited(parent, seen) if parent else ({}, [])
        values = dict(values)
        default = next((e for e in pkg.get('exports', []) if e['name'].startswith('Default__')), {})
        values.update(default.get('properties', {}))
        cache[path] = values, [path, *lineage]
        return cache[path]
    def refs(value):
        if isinstance(value, dict):
            if 'reference' in value:
                yield value['reference']
            for v in value.values():
                yield from refs(v)
        elif isinstance(value, list):
            for v in value:
                yield from refs(v)
    catalog, unresolved = {}, []
    for path, pkg in packages.items():
        if pkg.get('error'):
            unresolved.append({'package': path, 'error': pkg['error']})
            continue
        values, lineage = inherited(path)
        leaf = path.rsplit('/',1)[-1][:-7]
        cls = '/Game/'+path[len(BASE):-7]+'.'+leaf+'_C'
        animation_refs = sorted(set(r for e in pkg['exports'] for r in refs(e['properties'])
                                    if r.startswith(('AnimMontage\'', 'AnimSequence\'', 'BlendSpace'))))
        if leaf.startswith('FXC_'):
            catalog[cls] = {'package': path, 'lineage': lineage, 'animation_references': animation_refs,
                            'tail_seconds': values.get('EffectTailTime'), 'kind': 'named_effect_observation'}
            if any(p.endswith(('FXC_Global_Nearsight.uasset','FXC_Global_NearsightDebuff.uasset')) for p in lineage):
                props = {k:v for k,v in values.items() if k in ('OccluderRadius','FadeRadius','NearsightFadeInDuration',
                         'NearsightFadeOutDuration','OccluderBaseColor','FadeBaseColor','EffectTailTime')}
                model['vision_profiles'].setdefault(cls, {'name': leaf.removeprefix('FXC_').replace('_',' '),
                    'kind':'nearsight', 'asset_defaults':props, 'sources':{'inheritance':lineage},
                    'config_source':None, 'render_kind':'illustrative_overlay_not_shader_reconstruction'})
        for e in pkg['exports']:
            if e['type'] in ('UAnimMontage','UAnimSequence','UBlendSpace','UBlendSpace1D'):
                key = '/Game/'+path[len(BASE):-7]+'.'+e['name']
                props = e['properties']
                catalog[key] = {'package':path,'kind':'animation_asset_metadata','type':e['type'],
                    'duration_seconds':props.get('SequenceLength'), 'skeleton':props.get('Skeleton'),
                    'slot_tracks':props.get('SlotAnimTracks'), 'sections':props.get('CompositeSections'),
                    'blend_in':props.get('BlendIn'),'blend_out':props.get('BlendOut'),
                    'notifies':props.get('Notifies'), 'animation_references':animation_refs,
                    'skeletal_pose_reconstructed':False}
    model['agent_names'] = {p['package'].split('/')[3]:e['properties']['DisplayName']
        for p in agents['packages'] for e in p.get('exports',[]) if e['name'].startswith('Default__') and e['properties'].get('DisplayName')}
    model['asset_catalog'] = catalog
    model['catalog_provenance'] = {'archives':source['archives'],'mapping_sha256':source['mapping_sha256'],
        'inspected_packages':len(packages),'unresolved_packages':unresolved,'all_animations_reconstructed':False}
    return model


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('source',type=Path);p.add_argument('--agents',required=True,type=Path)
    p.add_argument('--base',required=True,type=Path);p.add_argument('--out',required=True,type=Path)
    p.add_argument('--animations',type=Path,action='append',default=[],help='Additional native animation metadata; repeat for multiple passes')
    a=p.parse_args()
    load=lambda path:json.loads(path.read_text(encoding='utf-8'))
    source=load(a.source)
    for animation_path in a.animations:
        extra=load(animation_path)
        if extra['archives']!=source['archives']:raise ValueError('Animation archives differ')
        packages={p['package']:p for p in source['packages']}
        packages.update({p['package']:p for p in extra['packages']})
        source['packages']=list(packages.values())
    model=make_catalog(source,load(a.agents),load(a.base))
    if model['archives'] != load(a.source)['archives']:
        raise ValueError('Asset catalog and base model archives differ')
    a.out.write_text(json.dumps(model,indent=2,allow_nan=False),encoding='utf-8')
    print(f"{len(model['asset_catalog'])} assets; {len(model['vision_profiles'])} vision profiles; {len(model['agent_names'])} agent names; {len(model['catalog_provenance']['unresolved_packages'])} unresolved packages")


if __name__=='__main__':main()
