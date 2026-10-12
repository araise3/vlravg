"""Inspect static-array serialization in one offline blend-space package."""
from pathlib import Path
from types import SimpleNamespace
import importlib.util

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('exporter',ROOT/'scripts/export-installed-animations.py')
exporter=importlib.util.module_from_spec(spec);spec.loader.exec_module(exporter)
args=SimpleNamespace(paks=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'),
    mappings=ROOT/'.tools/fmodel/mappings/VALORANT_13.06_zs.usmap',aes_key=exporter.inspector.asset_map.AES)
reader,handle=exporter.inspector.asset_map.initialize(args)
package=reader.LoadPackage('ShooterGame/Content/Characters/_Core/3P/Anims/Grenade/TP_Core_Grenade_CrouchIdle_UB_AimOffset.uasset')
package=getattr(package,'__implementation__',package)
obj=next(v.Value for v in package.ExportsLazy if 'BlendSpace' in str(v.Value.GetType().Name))
obj=getattr(obj,'__implementation__',obj)
print('fields',[(str(f.Name),str(f.FieldType)) for f in obj.GetType().GetFields()],flush=True)
print('typed_axes',exporter.inspector.value_json(obj.BlendParameters),flush=True)
print('typed_grid',exporter.inspector.value_json(obj.GridSamples)[:4],flush=True)
for tag in obj.Properties:
    if str(tag.Name)=='BlendParameters':print('axis_tag',tag.ArrayIndex,exporter.inspector.value_json(tag.Tag.Value),flush=True)
