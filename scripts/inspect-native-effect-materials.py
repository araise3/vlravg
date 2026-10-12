"""Extract compiled materials reached through the pinned effect render closure."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inspect(args):
    closure_raw = args.closure.read_bytes()
    closure = json.loads(closure_raw)
    inventory = json.loads((args.source / 'manifest.json').read_bytes())['inventory']
    if closure['mapping_sha256'] != inventory['mapping_sha256'] or closure['archives'] != inventory['archives'] or \
       closure['generator_sha256'] != digest((ROOT / 'scripts/inspect-native-effect-render-closure.py').read_bytes()):
        raise ValueError('Effect material closure provenance differs')
    for path in (args.model, args.smoke_model, args.effect_rules):
        model = json.loads(path.read_bytes())
        if model['mapping_sha256'] != inventory['mapping_sha256'] or model['archives'] != inventory['archives']:
            raise ValueError('Effect material model/source provenance differs')
    for path, record in closure['packages'].items():
        if digest((args.closure.parent / record['file']).read_bytes()) != record['sha256']:
            raise ValueError('Effect render package receipt differs: ' + path)
    spec = importlib.util.spec_from_file_location('effect_material_extractor', ROOT / 'scripts/inspect-native-visibility-materials.py')
    extractor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(extractor)
    receipts = {p: {k: r['origin'][k] for k in ('file', 'sha256')} for p, r in closure['packages'].items()
        if r['origin']['kind'] == 'pinned_behavior_source'}
    # Reuse the checked shader archive/container decoder, replacing only its
    # source-bound root set. Both generators and the closure are pinned below.
    extractor.material_roots = lambda *unused: (closure['material_candidates'], receipts)
    extractor.inspect(args)
    path = args.out / 'materials.json'
    result = json.loads(path.read_bytes())
    result.update({'render_closure_sha256': digest(closure_raw),
        'render_closure_file': str(args.closure.resolve()),
        'closure_generator_sha256': digest(Path(__file__).read_bytes()),
        'scope': 'Material candidates reached by the bounded serialized FXC/component/widget/particle closure, plus material parents. Runtime material selection and unexpanded render inputs remain unresolved.'})
    path.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('closure', 'source', 'model', 'smoke-model', 'effect-rules', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--paks', type=Path, default=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'))
    parser.add_argument('--mappings', type=Path, default=ROOT / '.tools/fmodel/mappings/VALORANT_13.06_zs.usmap')
    inspect(parser.parse_args())
