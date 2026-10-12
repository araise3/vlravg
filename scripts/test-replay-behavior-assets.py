"""Checks that decoding gaps cannot turn into supported behavior claims."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent.parent
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
coverage=module('behavior_coverage','build-behavior-coverage.py')
inspection=module('behavior_inspection','inspect-installed-behaviors.py')
fixture=json.loads((ROOT/'tests/fixtures/replay-behavior-13.06.json').read_text(encoding='utf-8'))

class CoverageTests(unittest.TestCase):
    capabilities={'opcodes':['EX_Let','EX_LocalOutVariable','EX_InstanceVariable','EX_Return','EX_Nothing','EX_EndOfScript'], 'native_bindings':[]}
    def test_extracted_duration_function_is_structurally_supported_without_claiming_native_validation(self):
        result=coverage.assess({'ScriptBytecode':fixture['functions']['smoke_duration']['code']},self.capabilities)
        self.assertTrue(result['structurally_supported']);self.assertFalse(result['validated_against_native_engine'])
    def test_untyped_name_operand_blocks_execution_even_when_call_is_bound(self):
        cap={'opcodes':['EX_CallMath','EX_EndOfScript'],'native_bindings':['/Script/Engine.Bound:Function']}
        code=[{'expression_type':'EX_CallMath','StackNode':{'reference':"Class'/Script/Engine.Bound:Function'"},'Parameters':[['Name']]},{'expression_type':'EX_EndOfScript'}]
        result=coverage.assess({'ScriptBytecode':code},cap)
        self.assertFalse(result['structurally_supported']);self.assertIn('untyped_parameter',result['gaps'])
    def test_native_calls_and_incomplete_scripts_are_counted_as_dependencies(self):
        result=coverage.assess({'ScriptBytecode':[{'expression_type':'EX_CallMath','StackNode':{'reference':"Class'/Script/ShooterGame.Native:Behavior'"},'Parameters':[]}]},self.capabilities)
        self.assertIn('incomplete_or_native_script',result['gaps']);self.assertIn('call:/Script/ShooterGame.Native:Behavior',result['gaps'])
    def test_nonfinite_values_are_preserved_as_unresolved_not_zero(self):
        value=inspection.portable({'curve':[float('nan'),float('inf'),3.0]})
        self.assertEqual(value['curve'][2],3)
        self.assertEqual(value['curve'][0],{'unresolved_numeric':'nan'})
        self.assertEqual(value['curve'][1],{'unresolved_numeric':'inf'})
        result=coverage.assess({'ScriptBytecode':[{'expression_type':'EX_Nothing','value':value},{'expression_type':'EX_EndOfScript'}]},self.capabilities)
        self.assertFalse(result['structurally_supported'])

class SerializationTests(unittest.TestCase):
    def test_quaternion_preserves_fourth_component(self):
        class Quaternion:
            X=0.;Y=0.;Z=0.;W=1.
        self.assertEqual(inspection.inspector.value_json(Quaternion()),{'X':0.,'Y':0.,'Z':0.,'W':1.})

    def test_kismet_struct_is_typed_before_generic_properties(self):
        class Field:
            IsStatic=False
            def __init__(self,name):self.Name=name
            def GetValue(self,o):return getattr(o,self.Name)
        class Type:
            Namespace='CUE4Parse.UE4.Kismet';Name='EX_StructConst';IsArray=False
            def GetFields(self):return [Field('Properties'),Field('StatementIndex')]
        class Expression:
            Properties=[];StatementIndex=13
            def GetType(self):return Type()
        self.assertEqual(inspection.inspector.value_json(Expression()),{'expression_type':'EX_StructConst','Properties':[],'StatementIndex':13})

    def test_kismet_array_stays_an_array(self):
        class Type:
            Namespace='CUE4Parse.UE4.Kismet';Name='KismetExpression[]';IsArray=True
            def GetFields(self):return []
        class Array:
            def GetType(self):return Type()
            def __iter__(self):return iter([1,2])
        self.assertEqual(inspection.inspector.value_json(Array()),[1,2])

class CallClosureTests(unittest.TestCase):
    def test_transitive_native_dependency_blocks_all_its_callers(self):
        def entry(name,calls,gaps):return {'function':{'name':name,'ScriptBytecode':[]},'source':{'calls':calls,'gaps':gaps,'program_sha256':name,'source_record_sha256':'record'}}
        functions={'/Game/A':entry('A',['/Game/B'],['call:/Game/B']),
            '/Game/B':entry('B',['/Game/C'],['call:/Game/C']),
            '/Game/C':entry('C',['/Script/Native'],['call:/Script/Native']),
            '/Game/D':entry('D',[],[])}
        self.assertEqual(set(coverage.compile_call_closure(functions)),{'/Game/D'})
        functions['/Game/C']=entry('C',[],[])
        compiled=coverage.compile_call_closure(functions)
        self.assertEqual(set(compiled),set(functions));self.assertEqual(compiled['/Game/A']['object_path'],'/Game/A')
    def test_unbound_virtual_dispatch_is_not_resolved_as_a_final_call(self):
        row={'function':{'name':'A','ScriptBytecode':[]},'source':{'calls':[],'gaps':['dispatch_requires_receiver_binding:Tick']}}
        self.assertEqual(coverage.compile_call_closure({'/Game/A':row}),{})

if __name__=='__main__':unittest.main()
