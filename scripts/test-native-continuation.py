"""Real cooked graph/shader fixtures guard source flow and unknown runtime inputs."""
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


clocks = module('clock_fixture', 'build-native-activation-clocks.py')
graphs = module('graph_fixture', 'inspect-native-animation-graphs.py')
shaders = module('shader_fixture', 'inspect-native-shader-inputs.py')


class NativeContinuationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = json.loads(gzip.decompress((ROOT / 'tests/fixtures/native-continuation-13.06.json.gz').read_bytes()))
        cls.packages, cls.assembly = {}, {}
        for key, row in fixture['sources'].items():
            raw = base64.b64decode(row['gzip_base64'], validate=True)
            if hashlib.sha256(raw).hexdigest() != row['sha256']:
                raise ValueError('Fixture source receipt differs')
            cls.packages[key] = json.loads(gzip.decompress(raw))
        for key, row in fixture['shaders'].items():
            raw = base64.b64decode(row['disassembly_base64'], validate=True)
            if hashlib.sha256(raw).hexdigest() != row['disassembly_sha256']:
                raise ValueError('Fixture compiled disassembly receipt differs')
            cls.assembly[key] = raw.decode()

    def test_smoke_timers_are_relative_to_dispatch_and_keep_clock_unknown(self):
        proof = clocks.prove_smoke(self.packages['smoke'])
        self.assertEqual(len(proof['timers']), 4)
        self.assertEqual(proof['timers'][1]['source_event'], 'ExpandSmoke')
        self.assertEqual(proof['timers'][2]['interval_expression'],
            'float32(virtual_GetSmokeDuration() - SmokeEndTelegraphDuration)')
        self.assertEqual(proof['event_entries']['ReceiveBeginPlay']['entry_point'], 1555)
        self.assertFalse(proof['activation_clock_verified'])
        for timer in proof['timers']:
            self.assertFalse(timer['channel_open_is_clock_origin'])
            self.assertIsNone(timer['native_callback_time_ms'])

    def test_clock_proof_rejects_disconnected_cast_delegate_and_duration(self):
        mutations = [(3573, lambda n: n['Assignment']['Target']['Variable']['New'].update(Path=['ActorChannelOpenTime'])),
            (2480, lambda n: n.update(FunctionName='Event Play End Telegraph')),
            (2733, lambda n: n['Assignment']['Parameters'].reverse()),
            (2470, lambda n: n['BooleanExpression']['Variable']['New'].update(Path=['UnrelatedCondition']))]
        for index, mutate in mutations:
            with self.subTest(index=index):
                package = copy.deepcopy(self.packages['smoke'])
                graph = next(e['ScriptBytecode'] for e in package['exports'] if e['name'] == clocks.GRAPH)
                mutate(next(n for n in graph if n['StatementIndex'] == index))
                with self.assertRaises(ValueError):
                    clocks.prove_smoke(package)

    def test_symbolic_execution_keeps_both_begin_play_branches_and_rejects_bad_jump(self):
        package = copy.deepcopy(self.packages['smoke'])
        graph = next(e['ScriptBytecode'] for e in package['exports'] if e['name'] == clocks.GRAPH)
        reachable = clocks.reachable(graph, 1555)
        self.assertIn(1525, reachable)
        self.assertIn(1540, reachable)
        next(n for n in graph if n['StatementIndex'] == 1511)['CodeOffset'] = 1541
        with self.assertRaisesRegex(ValueError, 'non-statement'):
            clocks.reachable(graph, 1555)

    def test_cosmetic_graph_preserves_map_keys_and_member_alpha_writes(self):
        graph = graphs.summarize(self.packages['cypher_graph'])[0]
        info = graph['generated_class_properties']['GraphAssetPlayerInformation']['serialized_map']
        self.assertEqual(info[0]['key'], 'AnimGraph')
        self.assertEqual(info[0]['value']['PlayerNodeIndices'], [0, 2])
        targets = [w['target_path'] for w in graph['exposed_input_writes']]
        self.assertIn(['AnimGraphNode_SpringBone', 'Alpha'], targets)
        self.assertIn(['AnimGraphNode_ModifyBone', 'Alpha'], targets)
        copy_node = next(n for n in graph['nodes'] if n['property'] == 'AnimGraphNode_CopyPoseFromMesh')
        self.assertTrue(copy_node['serialized_inputs']['bUseAttachedParent'])
        self.assertFalse(graph['native_node_array_reconstructed'])
        self.assertTrue(all(p['resolved_target'] is None for n in graph['nodes'] for p in n['pose_links']))

    def test_camera_defaults_do_not_substitute_for_native_parent_execution(self):
        boundary = graphs.camera_boundary(self.packages['camera'])
        self.assertEqual(boundary['native_parent']['reference'], "Class'/Script/ShooterGame.ShooterCamera'")
        self.assertEqual(boundary['decoded_blueprint_function_names'], [])
        self.assertFalse(boundary['native_camera_reconstructed'])
        self.assertIsNone(boundary['achieved_camera_transform'])

    def test_sparse_cdo_recovers_native_velocity_paths_and_precision(self):
        folded = graphs.summarize(self.packages['core_graph'])[0]['folded_inputs']
        self.assertTrue(folded['sparse_cdo_captured'])
        self.assertEqual(len(folded['property_copy_routes']), 453)
        self.assertEqual(len(folded['exposed_value_handlers']), 491)
        route = folded['property_copy_routes'][0]
        self.assertEqual(route['source']['path_names'], ['AnimationStateParams', 'Velocity', 'X'])
        self.assertEqual(route['destinations'][0]['path_names'], ['__AnimBlueprintMutables', '__FloatProperty_22'])
        self.assertEqual(route['copy_type'], 'EPropertyAccessCopyType::DemoteDoubleToFloat')
        self.assertEqual(route['source']['segments'][0]['Property']['ResolvedOwner']['reference'],
            "Class'/Script/ShooterGame.ShooterCharacterAnimInstance'")
        self.assertIsNone(route['source']['runtime_value'])
        self.assertFalse(route['native_property_copy_executed'])
        self.assertEqual(folded['exposed_value_handlers'][1]['property_copy_records'][0]['serialized_record']['CopyIndex'], 111)
        self.assertTrue(all(h['native_node_index'] is None for h in folded['exposed_value_handlers']))

    def test_sparse_bound_functions_and_generated_struct_fields_are_preserved(self):
        folded = graphs.summarize(self.packages['cypher_graph'])[0]['folded_inputs']
        bound = folded['exposed_value_handlers'][0]
        self.assertTrue(bound['bound_function_exists'])
        self.assertIn('ModifyBone', bound['serialized_handler']['BoundFunction'])
        layout = next(l for l in folded['generated_struct_layouts'] if l['name'] == 'AnimBlueprintGeneratedConstantData')
        self.assertIn('__NameProperty_35', [p['Name'] for p in layout['child_properties']])
        self.assertEqual(folded['serialized_sparse_class_data']['__NameProperty_35'], 'AnimGraph')

    def test_sparse_paths_copy_ranges_and_handlers_reject_corrupt_indices(self):
        mutations = [lambda d: d['AnimBlueprintExtension_PropertyAccess']['Library']['SrcPaths'][0].update(PathSegmentCount=999999),
            lambda d: d['AnimBlueprintExtension_PropertyAccess']['Library']['CopyBatchArray'][0]['Copies'][0].update(AccessIndex=-1),
            lambda d: d['AnimBlueprintExtension_PropertyAccess']['Library']['CopyBatchArray'][0]['Copies'][0].update(DestAccessEndIndex=999999),
            lambda d: d['AnimBlueprintExtension_Base']['ExposedValueHandlers'][1]['CopyRecords'][0].update(CopyIndex=999999),
            lambda d: d['AnimBlueprintExtension_Base']['ExposedValueHandlers'][0].update(BoundFunction='NotARealFunction')]
        for mutate in mutations:
            package = copy.deepcopy(self.packages['core_graph'])
            default = next(e for e in package['exports'] if e['name'].startswith('Default__'))
            mutate(default['SerializedSparseClassData'])
            with self.assertRaises(ValueError):
                graphs.summarize(package)

    def test_smoke_compiled_alpha_route_is_exact_and_runtime_value_unknown(self):
        assembly = self.assembly['64A04C5DCA508364D3C1BAE3B85AC7FC62451963']
        inputs = shaders.alpha_inputs(assembly)
        self.assertEqual(len(inputs['alpha_outputs']), 1)
        route = shaders.direct_alpha_route(inputs['alpha_outputs'][0], assembly)
        self.assertEqual(route['formula'], 'saturate(cb1[5].w)')
        self.assertEqual(route['reflected_cbuffer_name'], 'UniformBufferConstants_Material')
        self.assertIsNone(route['runtime_value'])
        self.assertFalse(route['control_flow_evaluated'])

    def test_flash_ui_opacity_is_retained_as_an_additional_input(self):
        assembly = self.assembly['1BFFD1D17C07DED97A084FE2396DA4D4E7FAFE32']
        inputs = shaders.alpha_inputs(assembly)
        output = inputs['alpha_outputs'][0]
        loads = [n['expression'] for n in output['input_operations']]
        self.assertEqual(sum('@dx.op.cbufferLoad' in n for n in loads), 2)
        self.assertTrue(any('fmul' in n['expression'] for n in output['value_slice']))
        self.assertIsNone(shaders.direct_alpha_route(output, assembly))

    def test_phi_predecessors_are_control_flow_not_missing_numeric_uniforms(self):
        assembly = self.assembly['00D5FE4AC8914092CCF90BC7B91215B327ABFAD6']
        inputs = shaders.alpha_inputs(assembly)
        self.assertTrue(inputs['branch_instructions'])
        self.assertTrue(any('phi float' in n['expression'] for o in inputs['alpha_outputs'] for n in o['value_slice']))
        self.assertTrue(all(not o['unresolved_ssa_values'] for o in inputs['alpha_outputs']))
        self.assertTrue(all(shaders.direct_alpha_route(o, assembly) is None for o in inputs['alpha_outputs']))


if __name__ == '__main__':
    unittest.main()
