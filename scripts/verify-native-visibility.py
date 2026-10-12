"""Verify the integrated evaluator against concrete source-bound replay cases."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess

from replay_visibility_inputs import digest, SMOKES, ABILITIES
from replay_asset_model import smoke_radius

SPEC = importlib.util.spec_from_file_location('native_visibility', Path(__file__).with_name('build-replay-visibility.py'))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def observations(value):
    if isinstance(value, dict):
        if 'time_ms' in value:
            yield value
        for child in value.values():
            yield from observations(child)
    elif isinstance(value, list):
        for child in value:
            yield from observations(child)


def sample_at(report, time_ms):
    sample = next(s for s in report['samples'] if s['time_ms'] == time_ms)
    assert sample['life'] == 'true:true', 'Integration pair is not alive at the tested boundary'
    assert sample['pose_times_ms'] and all(0 <= time_ms - t <= 50 for t in sample['pose_times_ms']), 'Missing fresh recorded movement poses'
    return sample


def smoke_case(report, match, actor):
    sidecar_path = SMOKES / 'replays' / (match + '.json')
    sidecar = json.loads(sidecar_path.read_text())
    model = json.loads((SMOKES / 'smoke-model.json').read_text())
    instance = next(s for s in sidecar['smoke_instances'] if s['actor_net_guid'] == actor)
    profile = model['smoke_profiles'][instance['profile']]
    assert report['smoke_inputs_sha256'] == digest(sidecar_path)
    assert report['smoke_model_sha256'] == digest(SMOKES / 'smoke-model.json')
    assert sidecar['native_activation_clock_verified'] is False
    assert sidecar['native_visual_opacity_verified'] is False
    for source in (instance, profile):
        assert source['activation_clock_verified'] is False
        assert source['native_visual_opacity_verified'] is False
        assert source['interior_visibility_verified'] is False
    assert instance['model_clock_basis'] == 'channel_open_plus_serialized_delay'
    delay_end = instance['start_ms'] + profile['delay_ms']
    # Clove's curve starts at zero; Brimstone's authored first value is 0.1.
    # Select the first positive sample in this 50 ms test grid, without inventing
    # a native render start or treating the delay endpoint as opaque.
    positive_time = delay_end if smoke_radius(profile, profile['delay_ms']) > 0 else delay_end + 50
    before, active = sample_at(report, positive_time - 50), sample_at(report, positive_time)
    ids = lambda s: {hit['smoke_id'] for p in s['model_points'] for hit in p.get('smoke_hits', [])}
    assert instance['id'] not in ids(before), 'Additional smoke shell appeared before its conditional growth clock'
    assert instance['id'] in ids(active), 'Additional smoke profile/instance was not merged into the evaluator'
    assert smoke_radius(profile, positive_time - instance['start_ms']) > 0
    assert instance['round'] == active['round']
    # Exercise the conservative selector through the real smoke center. These
    # are dependency probes, not new observed player rays or native frames.
    data = report['_published_data']
    round_data = next(r for r in data['rounds'] if r['index'] == instance['round'])
    first = max(instance['channel_open_ms'], instance['positions'][0][0])
    times = [first - 1, first, instance['end_ms'], round_data['end_ms']]
    code = "const fs=require('node:fs'),v=require(process.argv[1]),m=require(process.argv[2]),d=JSON.parse(fs.readFileSync(process.argv[3]));const actor=Number(process.argv[4]),profile=JSON.parse(process.argv[5]),round=JSON.parse(process.argv[6]),times=JSON.parse(process.argv[7]),s=d.smoke_instances.find(x=>x.actor_net_guid===actor);process.stdout.write(JSON.stringify(times.map(t=>{const p=m.latest(s.positions,t,Infinity)||s.positions[0],a=p.slice(1,4);return {time_ms:t,dependencies:v.smokeDependencies([s],{[s.profile]:profile},a,a,t,round,m)};})));"
    probes = json.loads(subprocess.run(['node', '-e', code,
        str(Path(__file__).with_name('replay-visibility-runtime.js').resolve()),
        str(Path(__file__).with_name('replay-transcription-viewer.js').resolve()),
        str(sidecar_path.resolve()), str(actor), json.dumps(profile), json.dumps(round_data), json.dumps(times)],
        check=True, capture_output=True, text=True).stdout)
    assert not probes[0]['dependencies'] and len(probes[1]['dependencies']) == 1
    if first <= instance['end_ms'] < round_data['end_ms']:
        assert len(probes[2]['dependencies']) == 1, 'Modeled expiry was treated as native smoke extinction'
    assert not probes[3]['dependencies'], 'Smoke dependency crossed its half-open round cap'
    for probe in probes:
        for dep in probe['dependencies']:
            assert dep['position_observed_ms'] <= probe['time_ms']
            assert dep['native_visual_opacity_verified'] is False and dep['activation_clock_verified'] is False
    return {'actor_net_guid': actor, 'smoke_id': instance['id'], 'conditional_delay_end_ms': delay_end, 'positive_radius_sample_ms': positive_time,
        'model_clock_basis': instance['model_clock_basis'], 'native_visibility_verified': False}


def ability_case(report, review, match, actor, stop_phase=False):
    path = review / 'ability-occluder-inputs-v1' / (match + '.json')
    sidecar = json.loads(path.read_text())
    instance = next(i for i in sidecar['instances'] if i['actor_net_guid'] == actor)
    assert report['ability_inputs_sha256'] == digest(path)
    assert report['ability_model_sha256'] == digest(ABILITIES)
    assert sidecar['native_occlusion_complete'] is False
    assert instance['world_bounds_verified'] is False and instance['native_visibility_verified'] is False
    for sample in report['samples']:
        for dependency in sample['ability_dependencies']:
            assert dependency['round'] == sample['round']
            assert dependency['start_ms'] <= sample['time_ms'] < dependency['end_ms']
            assert dependency['world_bounds_verified'] is False and dependency['native_visibility_verified'] is False
            assert dependency['reason'] == 'ability_occluder_geometry_unknown'
            assert all(row['time_ms'] <= sample['time_ms'] for row in observations(dependency)), 'Future ability evidence leaked into an earlier sample'
            assert sample['model_state'] not in ('direct', 'reveal'), 'Unresolved ability geometry produced a model contact'
            if sample['state'] == 'unknown':
                assert 'ability_occluder_geometry_unknown' in sample['reasons']
    boundary = instance['observed_flag_end_ms'] if stop_phase else instance['start_ms']
    before, active = sample_at(report, boundary - 50), sample_at(report, boundary)
    selected = lambda s: next((i for i in s['ability_dependencies'] if i['actor_net_guid'] == actor), None)
    dependency = selected(active)
    assert dependency is not None, 'Potential ability boundary was not sampled/selected'
    if stop_phase:
        assert selected(before) is not None
        assert 'deactivation_observation' not in selected(before)
        assert dependency['deactivation_observation']['value'] is False
        assert dependency['end_ms'] > boundary, 'A false activation flag was treated as visual extinction'
    else:
        assert selected(before) is None, 'Future ability was selected before its potential start'
        assert 'deactivation_observation' not in dependency and not dependency['channel_close_observations']
        if instance['kind'] == 'vyse_wall':
            assert 'collision_enable_observation' not in dependency
            enabled = selected(sample_at(report, instance['collision_enable_observed_ms']))
            assert enabled['collision_enable_observation']['time_ms'] == instance['collision_enable_observed_ms']
    # Probe the same runtime selector with the actual replay sidecar at the
    # half-open knowledge cap; the analyzer cannot span a between-round gap.
    code = "const fs=require('node:fs'),v=require(process.argv[2]),d=JSON.parse(fs.readFileSync(process.argv[1]));const [actor,round,end]=process.argv.slice(3).map(Number);process.stdout.write(JSON.stringify([end-1,end].map(t=>({time_ms:t,dependencies:v.abilityDependencies(d,t,round).filter(i=>i.actor_net_guid===actor)}))));"
    probes = json.loads(subprocess.run(['node', '-e', code, str(path.resolve()),
        str(Path(__file__).with_name('replay-visibility-runtime.js').resolve()), str(actor), str(instance['round']), str(instance['end_ms'])],
        check=True, capture_output=True, text=True).stdout)
    assert len(probes[0]['dependencies']) == 1 and not probes[1]['dependencies'], 'Ability potential window crossed its exact knowledge cap'
    assert all(row['time_ms'] <= probes[0]['time_ms'] for row in observations(probes[0]['dependencies']))
    return {'actor_net_guid': actor, 'kind': instance['kind'], 'potential_window_ms': [instance['start_ms'], instance['end_ms']],
        'tested_boundary_ms': boundary, 'stop_phase': stop_phase, 'half_open_end_verified': True, 'native_visibility_verified': False}


def verify(corpus, review, out):
    out.mkdir(parents=True, exist_ok=True)
    cases = [
        ('contact', '8dac718f-24f5-4042-99a7-4a2a27f2d22f', 'P3', 'P2', 61771, 66271),
        ('flash-tail', '3daee3cf-e776-40c6-aa53-bae37d8a9de3', 'P3', 'P6', 201348, 202449),
        ('dizzy', '026ccda1-e290-421c-935d-a9b83e7add40', 'P5', None, 68818, 70921),
        ('remote-camera', '1163ee28-065c-41f6-8569-f6e43d7acfab', '1d50326c-7454-5240-a7ec-6ca04f7c9ea3', None, 43310, 43410),
        ('lotus-overlay', '161ed113-3628-49a5-835f-dbdad07fe812', 'P1', None, None, None),
        ('clove-smoke', '026ccda1-e290-421c-935d-a9b83e7add40', 'P1', 'P2', 51837, 51937),
        ('brim-smoke', 'a1a36f8c-f9b0-4c41-aeee-229f4ec8a95d', 'P10', 'P5', 46617, 46717),
        ('viper-wall', 'b01b274b-ced8-49c6-b88c-8efb81c18d48', 'P10', 'P5', 61932, 62032),
        ('vyse-wall', 'eaa39075-a650-4920-b2d1-59e5c574ff7a', 'P4', 'P2', 140307, 140857),
        ('viper-stop', 'b01b274b-ced8-49c6-b88c-8efb81c18d48', 'P4', 'P9', 72807, 72907),
    ]
    results = []
    for name, match, observer, target, start, end in cases:
        data = json.loads((review / 'library' / match / 'replay.json').read_text())
        player = next(p for p in data['players'] if observer in (p['slot'], p['subject']))
        if target is None:
            target = next(p['subject'] for p in data['players'] if p['team'] != player['team'])
        if start is None:
            start = data['rounds'][0]['start_ms'] + 1000
            end = start + 100
        path = out / (name + '.json')
        builder.build(corpus, review, match, observer, target, start, end, path)
        report = json.loads(path.read_text())
        assert report['validated_player_visibility'] is False
        assert not report['visibility']['contacts'], 'Unvalidated inputs produced certified visibility'
        assert all(s['state'] not in ('direct', 'reveal') for s in report['samples'])
        for sample in report['samples']:
            pose = sample.get('pose_assessment')
            if pose:
                assert pose['observer']['movement_observed_ms'] <= sample['time_ms']
                assert pose['target']['movement_observed_ms'] <= sample['time_ms']
                assert pose['observer']['native_camera_transform_verified'] is False
                assert pose['observer']['native_fov_verified'] is False
                assert pose['target']['native_skeletal_pose_verified'] is False
                assert pose['native_bindings_sha256'] == report['native_bindings_sha256']
            material = (sample.get('effect_assessment') or {}).get('flash_material_assessment')
            if material:
                assert material['parameter_value'] is None and material['native_clock_binding_verified'] is False
                assert material['shader_opacity_verified'] is False
            for dependency in sample['camera_dependencies']:
                assert 'stop_observation' not in dependency and 'end_reason' not in dependency
                assert all(row['time_ms'] <= sample['time_ms'] for row in observations(dependency))
        report['_published_data'] = data
        evidence = None
        if name == 'contact':
            assert report['model']['contacts'][0]['acquisition_bounds_ms'] == [63858, 63866]
        elif name == 'flash-tail':
            before = next(s for s in report['samples'] if s['time_ms'] == 201398)
            assert before['model_state'] == 'unknown'
            assert any(t['model_end_ms'] == 202398 for t in before['effect_assessment']['tails'])
            after = next(s for s in report['samples'] if s['time_ms'] == 202398)
            assert not after['effect_assessment']['tails'], 'Conditional fade crossed its exact endpoint'
        elif name == 'dizzy':
            sample = next(s for s in report['samples'] if s['time_ms'] == 68868)
            assert 'observed_unmodeled_vision_effect' in sample['effect_assessment']['candidate_reasons']
            assert sample['model_state'] == 'unknown'
        elif name == 'remote-camera':
            sample = next(s for s in report['samples'] if s['time_ms'] == 43360)
            assert sample['model_state'] == 'unknown'
            assert 'remote_viewpoint_dependency_observed' in sample['model_reasons']
            assert len([i for i in sample['camera_dependencies'] if i['actor_net_guid'] == 3872]) == 2
        elif name == 'lotus-overlay':
            assert len(report['geometry_overlays']) == 1
            assert report['geometry_overlays'][0]['triangles'] == 94461
        elif name in ('clove-smoke', 'brim-smoke'):
            evidence = smoke_case(report, match, 3734 if name == 'clove-smoke' else 3342)
        elif name in ('viper-wall', 'vyse-wall', 'viper-stop'):
            evidence = ability_case(report, review, match, 6518 if name == 'vyse-wall' else 4136, name == 'viper-stop')
        results.append({'case': name, 'match_id': match, 'samples': len(report['samples']),
            'report': str(path.resolve()), 'report_sha256': digest(path), 'provenance': report['provenance'], 'tested_evidence': evidence})
        print(f"Verified {name}: {len(report['samples'])} samples", flush=True)
    summary = {'schema_version': 1, 'passed': True, 'cases': results,
        'verifier_sha256': digest(Path(__file__)), 'native_player_visibility_validated': False}
    (out / 'validation.json').write_text(json.dumps(summary, indent=2))
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus', type=Path)
    parser.add_argument('review', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    verify(args.corpus, args.review, args.out)
