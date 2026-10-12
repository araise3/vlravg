"""Decode effect shader inputs, reusing only byte-exact pinned DXC outputs."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inspect(args):
    cached_raw = args.cached_inputs.read_bytes() if args.cached_inputs else None
    cached = json.loads(cached_raw) if cached_raw else None
    spec = importlib.util.spec_from_file_location('effect_shader_input_decoder', ROOT / 'scripts/inspect-native-shader-inputs.py')
    decoder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(decoder)
    tool = {'executable': str(args.dxc.resolve()), 'sha256': digest(args.dxc.read_bytes()),
        'companions': {name: digest((args.dxc.parent / name).read_bytes()) for name in ('dxcompiler.dll', 'dxil.dll')}}
    reusable = {}
    if cached:
        if cached['generator_sha256'] != digest((ROOT / 'scripts/inspect-native-shader-inputs.py').read_bytes()) or cached['disassembler'] != tool:
            raise ValueError('Cached disassembler/generator receipt differs')
        for row in cached['shaders'].values():
            raw = (args.cached_inputs.parent / row['file']).read_bytes()
            if digest(raw) != row['sha256']:
                raise ValueError('Cached DXC output receipt differs')
            reusable[row['compiled_sha256']] = (raw, row['diagnostics'])
    original_run = subprocess.run
    reused = executed = 0

    def run(command, **kwargs):
        nonlocal reused, executed
        if command[:2] != [str(args.dxc), '-dumpbin'] or len(command) != 3:
            raise ValueError('Unexpected command in shader decode cache')
        key = digest(Path(command[2]).read_bytes())
        if key in reusable:
            reused += 1
            stdout, stderr = reusable[key]
            return SimpleNamespace(stdout=stdout, stderr=stderr.encode())
        executed += 1
        return original_run(command, **kwargs)

    try:
        decoder.subprocess.run = run
        summary = decoder.inspect(args)
    finally:
        subprocess.run = original_run
    path = args.out / 'inputs.json'
    report = json.loads(path.read_bytes())
    report['decode_cache'] = {'generator_sha256': digest(Path(__file__).read_bytes()),
        'cached_inputs_sha256': digest(cached_raw) if cached_raw else None,
        'reused_byte_exact_outputs': reused, 'new_dxc_executions': executed}
    path.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    return {**summary, 'reused_byte_exact_outputs': reused, 'new_dxc_executions': executed}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('materials', 'dxc', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--cached-inputs', type=Path)
    print(json.dumps(inspect(parser.parse_args()), indent=2))
