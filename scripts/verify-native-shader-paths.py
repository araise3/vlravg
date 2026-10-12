"""Audit shader variant/program bindings and conditional HUD value paths."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def verify(args):
    materials = json.loads(args.materials.read_bytes())
    variants = json.loads(args.variants.read_bytes())
    hud = json.loads(args.hud_path.read_bytes())
    variant_module = module('shader_audit_variants', 'inspect-native-shader-variants.py')
    hud_module = module('shader_audit_hud', 'build-native-hud-shader-path.py')
    if variants['generator_sha256'] != digest((ROOT / 'scripts/inspect-native-shader-variants.py').read_bytes()) or \
       variants['materials_sha256'] != digest(args.materials.read_bytes()) or \
       variants['decoder_sha256'] != digest((ROOT / '.tools/fmodel/libs/CUE4Parse.dll').read_bytes()):
        raise ValueError('Shader variant input/decoder/generator receipt differs')
    if variants['source_reference_commit'] != (args.references / 'commit.txt').read_text().strip() or \
       variants['source_references'] != {p.name: digest(p.read_bytes()) for p in args.references.glob('*.cs')}:
        raise ValueError('Shader variant primary-source receipt differs')
    expected_owners, expected_resources = {}, set()
    occurrences = 0
    for path, package in sorted(materials['materials'].items()):
        for export in package['exports']:
            for resource in export['shader_maps']:
                rh = resource['resource_hash']
                expected_resources.add(rh)
                expected_owners.setdefault(rh, []).append({'package': path, 'export': export['name']})
                report = variants['resources'][rh]
                expected = variant_module.bind_resource(resource, report['typed_targets'], materials['shader_map_matches'][rh], variants['labels'])
                if report['platform'] != resource['platform'] or report['variants'] != expected:
                    raise ValueError('Shader variant binding differs')
                occurrences += len(expected)
    if set(variants['resources']) != expected_resources or any(r['owners'] != expected_owners[h] for h, r in variants['resources'].items()):
        raise ValueError('Shader variant owner/resource coverage differs')
    for report in (variants, hud):
        if report['mapping_sha256'] != materials['mapping_sha256'] or report['archives'] != materials['archives'] or \
           any(report[k] is not False for k in ('native_shader_opacity_verified', 'runtime_parameter_binding_verified',
               'activation_clock_verified', 'native_visibility_verified')):
            raise ValueError('Shader native verification was promoted or provenance differs')
    # Rebuild HUD paths from byte-exact shader outputs, not the reported tree.
    expected_hud = hud_module.build(argparse.Namespace(materials=args.materials, shaders=args.shaders,
        variants=args.variants, widget_route=args.widget_route))
    if hud != expected_hud:
        raise ValueError('HUD shader input/value/clock path differs')
    for resource in hud['resources'].values():
        pixel = resource['slate_default_pixel_paths'][0]['outputs']
        if len(pixel) != 1 or not pixel[0]['decoded_scalar_value_flow'] or pixel[0]['output_signature']['semantic'] != 'SV_Target':
            raise ValueError('Slate pixel path did not decode to the target alpha component')
        for vertex in resource['slate_vertex_color_alpha_paths']:
            tree = vertex['color_alpha_output']['symbolic_value_tree']
            if tree['operation'] != 'interpolated_input' or tree['signature']['semantic'] != 'ATTRIBUTE' or \
               tree['signature']['semantic_indices'] != [3] or tree['component'] != 3:
                raise ValueError('Slate vertex COLOR0 alpha pass-through differs')
    return {'schema_version': 1, 'kind': 'native_shader_path_evidence_audit', 'status': 'passed',
        'verifier_sha256': digest(Path(__file__).read_bytes()),
        'source_sha256': {k: digest(p.read_bytes()) for k, p in (('materials', args.materials), ('shaders', args.shaders),
            ('variants', args.variants), ('widget', args.widget_route), ('hud', args.hud_path))},
        'resource_count': len(expected_resources), 'unique_variant_records': sum(len(r['variants']) for r in variants['resources'].values()),
        'owner_variant_occurrences': occurrences,
        'primary_source_receipts_checked': True, 'typed_target_binding_recomputed': True, 'hud_value_paths_recomputed': True,
        'native_runtime_validation_performed': False,
        'native_shader_opacity_verified': False, 'runtime_parameter_binding_verified': False,
        'activation_clock_verified': False, 'native_visibility_verified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('materials', 'shaders', 'variants', 'widget-route', 'hud-path', 'references', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    report = verify(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
