"""Real particle/HUD fixtures guard object identity and unknown runtime values."""
import base64
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


particles = module('render_fixture_particles', 'inspect-native-effect-render-closure.py')
widget = module('render_fixture_widget', 'build-native-widget-material-route.py')


class NativeRenderBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = json.loads(gzip.decompress((ROOT / 'tests/fixtures/native-render-bindings-13.06.json.gz').read_bytes()))
        cls.packages = {}
        cls.hud_product = fixture['hud_product']
        for key, row in fixture['sources'].items():
            raw = base64.b64decode(row['gzip_base64'], validate=True)
            if hashlib.sha256(raw).hexdigest() != row['sha256']:
                raise ValueError('Render fixture receipt differs')
            package = json.loads(gzip.decompress(raw))
            if package['package'] != row['package']:
                raise ValueError('Render fixture package differs')
            cls.packages[key] = package

    def test_repeated_lod_and_emitter_names_keep_distinct_full_identities(self):
        system = particles.summarize_particles(self.packages['brim_particles'])[0]
        self.assertEqual(len(system['emitters']), 15)
        lods = [l for e in system['emitters'] for l in e['lods']]
        self.assertEqual(len({l['object_path'] for l in lods}), 15)
        self.assertTrue(all(l['object_path'].endswith('.ParticleLODLevel_0') for l in lods))
        debris = [e for e in system['emitters'] if e['emitter_name'] == 'DEBRIS']
        self.assertEqual(len(debris), 2)
        self.assertNotEqual(debris[0]['object_path'], debris[1]['object_path'])
        self.assertNotEqual(debris[0]['lods'][0]['object_path'], debris[1]['lods'][0]['object_path'])

    def test_emitter_delay_and_dynamic_values_are_source_inputs_not_activation(self):
        system = particles.summarize_particles(self.packages['brim_particles'])[0]
        decal = next(e for e in system['emitters'] if e['emitter_name'] == 'SmokeDecal')
        lod = decal['lods'][0]
        self.assertEqual(lod['clock_inputs']['EmitterDelay'], 1.2999999523162842)
        self.assertFalse(lod['clock_inputs']['bUseLegacyEmitterTime'])
        self.assertIsNone(decal['native_activation_time_ms'])
        self.assertIsNone(lod['native_particle_age_seconds'])
        self.assertIsNone(lod['achieved_opacity'])
        self.assertTrue(lod['lifetime_modules'])
        self.assertTrue(lod['dynamic_parameter_modules'])
        self.assertFalse(system['native_shader_opacity_verified'])

    def test_clove_particle_dynamic_parameters_retain_their_clock_choices(self):
        systems = particles.summarize_particles(self.packages['clove_particles'])
        dynamic = [p for s in systems for e in s['emitters'] for l in e['lods']
            for m in l['dynamic_parameter_modules'] for p in m['serialized_properties']['DynamicParams']]
        self.assertTrue(dynamic)
        self.assertTrue(all('bUseEmitterTime' in p and 'bSpawnTimeOnly' in p and 'ValueMethod' in p for p in dynamic))
        self.assertTrue(any(p['ParamValue'].get('Table', {}).get('Values') for p in dynamic))

    def test_particle_modules_reject_missing_or_wrong_full_object_references(self):
        for kind in ('missing', 'wrong_class'):
            package = copy.deepcopy(self.packages['brim_particles'])
            lod = next(e for e in package['exports'] if e['export_class'] == 'ParticleLODLevel')
            if kind == 'missing':
                lod['properties']['RequiredModule']['reference'] = "ParticleModuleRequired'/Game/Missing.Missing'"
            else:
                emitter = next(e for e in package['exports'] if e['export_class'] == 'ParticleSpriteEmitter')
                emitter['properties']['LODLevels'][0]['reference'] = lod['properties']['RequiredModule']['reference']
            with self.assertRaises(ValueError):
                particles.summarize_particles(package)

    def test_first_person_and_broadcast_defaults_bind_the_hud_flash_material(self):
        proof = widget.prove_widget(self.packages['widget'],
            [self.packages['first_person_hud'], self.packages['broadcast_hud']])
        self.assertEqual(len(proof['serialized_hud_instances']), 2)
        self.assertEqual({i['base_material_package'] for i in proof['serialized_hud_instances']},
            {'ShooterGame/Content/VFX/BuffsDebuffs/1P_HUD_FlashBackground_MI.uasset'})
        self.assertEqual(proof['proof_statements'], [614, 643, 658, 703, 722])
        self.assertEqual(proof['scalar_and_clock_proof']['parameter_name'], 'Alpha_ColorMult')
        self.assertTrue(proof['image_serialized_brush']['ResourceObject']['reference'].startswith("Texture2D'"))
        self.assertFalse(proof['runtime_parameter_binding_verified'])
        self.assertFalse(proof['activation_clock_verified'])

    def test_widget_route_rejects_wrong_material_storage_image_and_disconnected_flow(self):
        mutations = [(658, lambda n: n['Assignment']['Parameters'][1]['Variable']['New'].update(Path=['OtherMaterial'])),
            (703, lambda n: n['Variable']['Variable']['New'].update(Path=['OtherInstance'])),
            (722, lambda n: n['ObjectExpression']['Variable']['New'].update(Path=['OtherImage'])),
            (509, lambda n: n.update(PushingAddress=768))]
        for index, mutate in mutations:
            package = copy.deepcopy(self.packages['widget'])
            graph = next(e['ScriptBytecode'] for e in package['exports'] if e['name'] == widget.GRAPH)
            mutate(next(n for n in graph if n['StatementIndex'] == index))
            with self.assertRaises(ValueError):
                widget.prove_widget(package, [self.packages['first_person_hud'], self.packages['broadcast_hud']])

    def test_actual_hud_alpha_correspondence_retains_the_global_alpha_product(self):
        resource = self.hud_product['resource']
        products = widget.scalar_parameter_products(resource)
        self.assertEqual(len(products), 1)
        self.assertEqual(products[0]['serialized_opcode_bytes'], [3, 2, 0, 3, 3, 0, 6])
        self.assertEqual(products[0]['field']['BufferOffset'], 17)
        self.assertEqual(products[0]['symbolic_formula'], 'Alpha_ColorMult * GlobalAlpha')
        routes = widget.resource_routes(resource, self.hud_product['shader_resource'])
        route = next(r for r in routes['compiled_direct_alpha_routes'] if r['shader_hash'] == '6D50E46E445885070A871353659EC2839AFDB380')
        self.assertEqual(route['formula'], 'saturate(cb1[4].y)')
        self.assertEqual(route['conditional_parameter_formula'], 'saturate(Alpha_ColorMult * GlobalAlpha)')
        self.assertIsNone(route['runtime_value'])
        self.assertFalse(route['native_uniform_binding_verified'])

    def test_product_rejects_bad_indices_and_leaves_other_opcodes_uninterpreted(self):
        resource = copy.deepcopy(self.hud_product['resource'])
        uniform = resource['content']['MaterialCompilationOutput']['UniformExpressionSet']
        uniform['UniformPreshaderData']['Data'][40:42] = [255, 255]
        with self.assertRaises(ValueError):
            widget.scalar_parameter_products(resource)
        resource = copy.deepcopy(self.hud_product['resource'])
        uniform = resource['content']['MaterialCompilationOutput']['UniformExpressionSet']
        uniform['UniformPreshaderData']['Data'][45] = 4
        self.assertEqual(widget.scalar_parameter_products(resource), [])


if __name__ == '__main__':
    unittest.main()
