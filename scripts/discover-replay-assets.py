"""Find installed asset packages referenced by every validated replay.

Produces package lists for inspect-transcription-assets.py. An optional earlier
inspection pass adds nested animation references. No account IDs are exported.
"""
import argparse
import json
from pathlib import Path

import duckdb
from replay_observations import guid_paths
from replay_asset_model import reference_package


def package(path):
    if not path or not path.startswith('/Game/'):
        return None
    return 'ShooterGame/Content/'+path[6:].split('.',1)[0]+'.uasset'


def animation_packages(value):
    if isinstance(value,dict):
        ref=value.get('reference','')
        if ref.startswith(('AnimMontage\'', 'AnimSequence\'', 'BlendSpace')):
            target=reference_package(value)
            if target:yield target
        for child in value.values():yield from animation_packages(child)
    elif isinstance(value,list):
        for child in value:yield from animation_packages(child)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('corpus',type=Path)
    p.add_argument('--out',required=True,type=Path)
    p.add_argument('--catalog-source',type=Path,action='append',default=[])
    a=p.parse_args();corpus=json.loads(a.corpus.read_text(encoding='utf-8'))
    effects,animations,agents=set(),set(),set()
    for record in corpus['replays']:
        if record['status']!='validated':continue
        export=Path(record['export']);con=duckdb.connect(config={'threads':2})
        try:
            paths=guid_paths(con.execute('SELECT net_guid,path,outer_net_guid FROM read_parquet(?)',[str(export/'net_guids.parquet')]).fetchall())
            refs=con.execute("SELECT DISTINCT field_name,value_i64 FROM read_parquet(?) WHERE value_i64 IS NOT NULL AND ((group_path='/Script/ShooterGame.EffectManagerComponent_ClassNetCache' AND ends_with(field_name,'.EffectContainer')) OR regexp_matches(field_name,'Anim|Montage'))",[str(export/'fields.parquet')]).fetchall()
            for field,guid in refs:
                target=package(paths.get(guid))
                if target:(effects if field.endswith('.EffectContainer') else animations).add(target)
            manifest=json.loads((export/'manifest.json').read_text(encoding='utf-8'))
            bodies=[guid for player in manifest['players'] for guid in player.get('character_net_guids',[]) or [player.get('character_net_guid')] if guid is not None]
            classes=con.execute('SELECT DISTINCT class_path FROM read_parquet(?) WHERE actor_net_guid IN (SELECT UNNEST(?))',[str(export/'actors.parquet'),bodies]).fetchall()
            for (path,) in classes:
                if path and path.startswith('/Game/Characters/'):
                    code=path.split('/')[3]
                    if code!='_Core':agents.add(f'ShooterGame/Content/Characters/{code}/{code}_UIData.uasset')
        finally:con.close()
    for source in a.catalog_source:
        report=json.loads(source.read_text(encoding='utf-8'))
        for obj in report['packages']:
            animations.update(animation_packages(obj.get('exports',[])))
    a.out.mkdir(parents=True,exist_ok=True)
    for name,values in [('effects',effects),('animations',animations),('agents',agents)]:
        (a.out/(name+'-packages.json')).write_text(json.dumps(sorted(values),indent=2),encoding='utf-8')
        print(f'{name}: {len(values)} packages')


if __name__=='__main__':main()
