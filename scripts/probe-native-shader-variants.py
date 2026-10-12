"""Read-only scratch probe for cooked shader type/target metadata."""
import argparse
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('shader_probe_assets', ROOT / 'scripts/inspect-transcription-assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
args = argparse.Namespace(paks=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'),
    mappings=ROOT / '.tools/fmodel/mappings/VALORANT_13.06_zs.usmap', aes_key=assets.asset_map.AES)
reader, handle = assets.asset_map.initialize(args)
reader.ReadShaderMaps = True
from CUE4Parse.Utils import CityHash
from CUE4Parse.UE4.Assets.Exports.Material import HashedNamesProvider
from System import Array, Byte, UInt64
import clr
print('CITY METHODS', [str(m) for m in clr.GetClrType(CityHash).GetMethods() if 'CityHash64' in str(m.Name)])
obj = next(o for o in reader.LoadPackage('ShooterGame/Content/VFX/BuffsDebuffs/1P_FlashBackground_main.uasset').GetExports()
    if hasattr(o, 'LoadedMaterialResources'))
for resource in obj.LoadedMaterialResources:
    shader_map = resource.LoadedShaderMap
    print('RESOURCE', str(shader_map.ResourceHash), str(shader_map.ShaderPlatform))
    for dependency in shader_map.PointerTable.TypeDependencies:
        HashedNamesProvider.TryAdd(str(dependency.Name))
    for group in [shader_map.Content, *shader_map.Content.OrderedMeshShaderMaps]:
        for shader in group.Shaders:
            ok, name = HashedNamesProvider.TryGetEntry(UInt64(shader.Type.Hash))
            print('SHADER', int(shader.ResourceIndex), str(name) if ok else None, int(shader.Type.Hash),
                str(shader.Target.Frequency), str(shader.Target.Platform))
