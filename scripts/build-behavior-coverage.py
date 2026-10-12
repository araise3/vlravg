"""Measure discovered/decoded/supported/validated rules, with dependency gaps."""
from __future__ import annotations
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parent.parent


def walk(value):
    if isinstance(value,dict):
        yield value
        for child in value.values():yield from walk(child)
    elif isinstance(value,list):
        for child in value:yield from walk(child)


def canonical(ref):
    return re.sub(r"'?$",'',re.sub(r"^[^']*'",'',ref))


def digest(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def assess(function,capabilities):
    code=function.get('ScriptBytecode') or []
    nodes=list(walk(code));opcodes=sorted({n['expression_type'] for n in nodes if n.get('expression_type','').startswith('EX_')})
    calls=sorted({canonical(n.get('StackNode',{}).get('reference','')) for n in nodes
                  if n.get('expression_type') in ('EX_CallMath','EX_FinalFunction','EX_LocalFinalFunction')})
    dispatches=sorted({str(n.get('VirtualFunctionName','<unresolved>')) for n in nodes
                      if n.get('expression_type') in ('EX_VirtualFunction','EX_LocalVirtualFunction')})
    gaps=[]
    if not code or code[-1].get('expression_type')!='EX_EndOfScript':gaps.append('incomplete_or_native_script')
    gaps.extend('opcode:'+op for op in opcodes if op not in capabilities['opcodes'])
    gaps.extend('call:'+ref for ref in calls if ref not in capabilities['native_bindings'])
    gaps.extend('dispatch_requires_receiver_binding:'+name for name in dispatches)
    gaps.extend('cast:'+str(n.get('ConversionType',{}).get('value__')) for n in nodes
                if n.get('expression_type')=='EX_Cast' and n.get('ConversionType',{}).get('value__') not in capabilities.get('cast_tokens',[]))
    if any('unexpanded' in n or 'unresolved_numeric' in n for n in nodes):gaps.append('unexpanded_or_nonfinite_value')
    # Serialized expressions must keep their opcode. Some CUE expression types
    # implement IEnumerable and serialize as a list, which is insufficient for
    # interpreting that operand. Detect, report and reject that ambiguity.
    for n in nodes:
        for key in ('Assignment','ReturnExpression','ObjectExpression','ContextExpression','BooleanExpression','CodeOffsetExpression',
                    'AssignmentExpression','StructExpression','IndexTerm','DefaultTerm','CaseIndexValueTerm','CaseTerm','Target'):
            if key in n and (not isinstance(n[key],dict) or not n[key].get('expression_type')):gaps.append('untyped_operand:'+key)
        if 'Parameters' in n and any(not isinstance(v,dict) or not v.get('expression_type') for v in n['Parameters']):gaps.append('untyped_parameter')
    return {'opcodes':opcodes,'calls':calls,'dynamic_dispatches':dispatches,'gaps':sorted(set(gaps)),
            'no_op_function':bool(code) and set(opcodes)<= {'EX_Return','EX_Nothing','EX_EndOfScript'},
            'structurally_supported':not gaps,'validated_against_native_engine':False}


def compile_call_closure(functions):
    """Keep only programs whose final asset-call dependencies are supported.

    Receiver-dependent virtual dispatch remains an explicit binding gap. Cyclic
    final calls may be compiled, but the interpreter's call/step budgets still
    bound execution. This stage does not bind runtime objects or event clocks.
    """
    candidates={path for path,row in functions.items()
                if all(g.startswith('call:/Game/') for g in row['source']['gaps'])}
    while True:
        rejected={path for path in candidates if any(ref.startswith('/Game/') and ref not in candidates
                  for ref in functions[path]['source']['calls'])}
        if not rejected:break
        candidates-=rejected
    programs={}
    for path in sorted(candidates):
        row=functions[path];function=row['function']
        programs[path]={'name':function['name'],'object_path':path,'code':function['ScriptBytecode'],
            'ChildProperties':function.get('ChildProperties',[]),'FunctionFlags':function.get('FunctionFlags'),
            'EventGraphFunction':function.get('EventGraphFunction'),'EventGraphCallOffset':function.get('EventGraphCallOffset'),
            'program_sha256':row['source']['program_sha256'],'source_record_sha256':row['source']['source_record_sha256']}
    return programs


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('inventory',type=Path);p.add_argument('source',type=Path);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--node',default='node');a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    inventory=json.loads((a.inventory/'summary.json').read_text(encoding='utf-8'))
    manifest=json.loads((a.source/'manifest.json').read_text(encoding='utf-8'))
    if manifest['inventory']!=inventory['fingerprint']:raise ValueError('Inspection and inventory fingerprints differ')
    capabilities=json.loads(subprocess.check_output([a.node,str(ROOT/'scripts/replay-behavior-runtime.js'),'--capabilities'],text=True))
    headers=[json.loads(line) for line in (a.inventory/'headers.jsonl').read_text(encoding='utf-8').splitlines()]
    selected={r['package']:r for r in headers if r['generated_classes'] or r['classes'].get('Function')}
    entries={r['package']:r for line in (a.source/'index.jsonl').read_text(encoding='utf-8').splitlines() if (r:=json.loads(line))}
    mounted={r['package'].casefold() for r in headers}
    packages,totals,op_counts,native_calls,gap_counts=[],Counter(),Counter(),Counter(),Counter()
    programs={};all_functions={};function_paths=set()
    validation=json.loads(subprocess.check_output([a.node,str(ROOT/'scripts/check-replay-behavior.cjs')],text=True))
    if validation['runtime_sha256']!=digest(ROOT/'scripts/replay-behavior-runtime.js'):raise ValueError('Validation runtime differs')
    fixture_hashes=set(validation['checked_program_hashes'])
    (a.out/'validation.json').write_text(json.dumps(validation,indent=2),encoding='utf-8')
    with gzip.open(a.out/'functions.jsonl.gz','wt',encoding='utf-8') as function_stream:
        for i,(path,head) in enumerate(selected.items(),1):
            row={'package':path,'functions_discovered':head['classes'].get('Function',0),'decoded':False,
                 'animation_graphs_discovered':head['classes'].get('AnimBlueprintGeneratedClass',0),
                 'function_support':{'supported':0,'blocked':0,'fixture_checked':0},'parents':head['generated_classes']}
            totals['animation_graphs_discovered']+=row['animation_graphs_discovered']
            item=entries.get(path)
            if item:
                source=a.source/item['file']
                if digest(source)!=item['sha256']:raise ValueError('Inspection record changed: '+path)
                data=json.loads(gzip.decompress(source.read_bytes()));row['decoded']=True
                row['export_errors']=data['errors'];totals['export_errors']+=len(data['errors'])
                totals['animation_graphs_decoded']+=sum(e['export_class']=='AnimBlueprintGeneratedClass' for e in data['exports'])
                dependencies=sorted({n['reference'] for n in walk(data) if n.get('reference') and '/Game/' in n['reference']})
                unresolved=[]
                for ref in dependencies:
                    match=re.search(r'(/Game/[^\'.:]+)',ref)
                    base='ShooterGame/Content/'+match[1][6:] if match else None
                    if base and not any((base+ext).casefold() in mounted for ext in ('.uasset','.umap')):unresolved.append(ref)
                row['missing_package_references']=unresolved;totals['missing_package_references']+=len(unresolved)
                for e in data['exports']:
                    if e['export_class']!='Function':continue
                    info=assess(e,capabilities);totals['functions_decoded']+=1
                    op_counts.update(info['opcodes']);native_calls.update(c for c in info['calls'] if c.startswith('/Script/'))
                    gap_counts.update(info['gaps']);key=path+':'+e['name']
                    sha=hashlib.sha256(json.dumps(e.get('ScriptBytecode') or [],separators=(',',':'),sort_keys=True).encode()).hexdigest()
                    info.update(package=path,function=e['name'],program_sha256=sha,source_record_sha256=item['sha256'],
                                fixture_checked=sha in fixture_hashes)
                    object_path=e.get('object_path')
                    if object_path:
                        if object_path in function_paths:raise ValueError('Duplicate function path: '+object_path)
                        function_paths.add(object_path)
                        # Keep only possible call-closure members in memory.
                        # Other decoded targets remain unsupported dependencies.
                        if all(g.startswith('call:/Game/') for g in info['gaps']):all_functions[object_path]={'function':e,'source':info}
                    function_stream.write(json.dumps(info)+'\n')
                    status='supported' if info['structurally_supported'] else 'blocked'
                    row['function_support'][status]+=1;totals['functions_'+status]+=1
                    if info['fixture_checked']:row['function_support']['fixture_checked']+=1;totals['fixture_checked']+=1
                    if info['structurally_supported']:
                        if info['no_op_function']:totals['supported_no_op_functions']+=1
                        programs[key]={'source':info,'code':e['ScriptBytecode']}
                row['serialization_gaps']=sum('unexpanded' in n or 'unresolved_numeric' in n for n in walk(data))
                totals['serialization_gaps']+=row['serialization_gaps'];totals['decoded_packages']+=1
            packages.append(row)
            if i%10000==0:print(f'{i}/{len(selected)} coverage records',flush=True)
    compiled=compile_call_closure(all_functions)
    totals['final_asset_call_closure_programs']=len(compiled)
    totals['additional_programs_with_compiled_asset_calls']=sum(not all_functions[path]['source']['structurally_supported'] for path in compiled)
    with (a.out/'compiled-programs.json.gz').open('wb') as stream:
        payload={'schema_version':1,'runtime_sha256':digest(ROOT/'scripts/replay-behavior-runtime.js'),
            'mapping_sha256':manifest['inventory']['mapping_sha256'],'programs':compiled,
            'semantics':'expression_and_final_asset_call_closure_with_explicit_runtime_bindings',
            'native_engine_fidelity_validated':False}
        stream.write(gzip.compress(json.dumps(payload,separators=(',',':'),allow_nan=False).encode(),mtime=0))
    registry_validation=json.loads(subprocess.check_output([a.node,str(ROOT/'scripts/check-replay-call-registry.cjs'),str(a.out/'compiled-programs.json.gz')],text=True))
    (a.out/'registry-validation.json').write_text(json.dumps(registry_validation,indent=2),encoding='utf-8')
    report={'schema_version':1,'inventory':{k:inventory[k] for k in ('mounted_packages','successful_headers','complete_inventory','registry_assets')},
        'provenance':manifest,'runtime_sha256':digest(ROOT/'scripts/replay-behavior-runtime.js'),
        'behavior_packages':len(selected),'complete_inspection':totals['decoded_packages']==len(selected),
        'totals':dict(totals),'native_call_counts':dict(native_calls.most_common()),'opcode_counts':dict(op_counts.most_common()),
        'compiled_registry_sha256':registry_validation['registry_sha256'],
        'gap_counts':dict(gap_counts.most_common()),'packages':packages,'capabilities':capabilities,
        'validation':'Fixtures check the evaluator against extracted programs and explicit modeled bindings; no native-engine visual parity claim.',
        'limitations':['Header inventory covers every mounted package; decoding and runtime support are separate measures.',
            'Structurally supported functions still require their inputs, object bindings and invocation clocks.',
            'Native ShooterGame calls, animation graph execution, material shaders and runtime tuning remain unresolved.',
            'Missing or untyped operands fail evaluation; unsupported programs never apply partial commands.',
            'Same mapping/archive fingerprints do not independently prove replay build parity.']}
    (a.out/'coverage.json').write_text(json.dumps(report,separators=(',',':'),allow_nan=False),encoding='utf-8')
    (a.out/'supported-programs.json').write_text(json.dumps({'schema_version':1,'runtime_sha256':report['runtime_sha256'],'programs':programs},separators=(',',':')),encoding='utf-8')
    (a.out/'index.html').write_text((ROOT/'scripts/replay-behavior-coverage-template.html').read_text(encoding='utf-8'),encoding='utf-8')
    print(json.dumps({'behavior_packages':len(selected),'complete_inspection':report['complete_inspection'],**totals},indent=2))


if __name__=='__main__':main()
