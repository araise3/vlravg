"""Inspect the installed offline animation decoder's public ABI, read-only."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('exporter',ROOT/'scripts/export-installed-animations.py')
exporter=importlib.util.module_from_spec(spec);spec.loader.exec_module(exporter)
args=SimpleNamespace(paks=Path(r'C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks'),
    mappings=ROOT/'.tools/fmodel/mappings/VALORANT_13.06_zs.usmap',aes_key=exporter.inspector.asset_map.AES)
reader,handle=exporter.inspector.asset_map.initialize(args)
import clr
clr.AddReference('CUE4Parse-Conversion')
from System.Runtime.InteropServices import Marshal
from CUE4Parse.UE4.Objects.Core.Math import FTransform
from CUE4Parse.ACL import ACLNative
print('transform_size',Marshal.SizeOf(clr.GetClrType(FTransform)),flush=True)
print('native_library',ACLNative.LIB_NAME,flush=True)
package=reader.LoadPackage('ShooterGame/Content/Characters/_Core/3P/Anims/Grenade/TP_Core_Grenade_AimW_UB.uasset')
package=getattr(package,'__implementation__',package)
obj=next(v.Value for v in package.ExportsLazy if str(v.Value.GetType().Name)=='UAnimSequence')
obj=getattr(obj,'__implementation__',obj)
print('fields',[(str(f.Name),str(f.FieldType)) for f in obj.GetType().GetFields()],flush=True)
data=getattr(obj.CompressedDataStructure,'__implementation__',obj.CompressedDataStructure)
print('compression',data.GetType(),flush=True)
if hasattr(data,'GetCompressedTracks'):
    tracks=data.GetCompressedTracks();head=tracks.GetTracksHeader()
    print('tracks_type',tracks.GetType(),flush=True)
    print('header',exporter.inspector.value_json(head),flush=True)
    print('map',exporter.inspector.value_json(obj.GetTrackMap())[:4],flush=True)
    print('tracks methods',[str(m) for m in tracks.GetType().GetMethods()],flush=True)
else:
    from CUE4Parse.UE4.Assets.Exports.Animation import EAdditiveAnimationType
    from CUE4Parse_Conversion.Animations import AnimConverter
    old_type=obj.AdditiveAnimType
    try:
        obj.AdditiveAnimType=EAdditiveAnimationType.AAT_None
        raw=AnimConverter.ConvertAnims(obj).Sequences[0]
    finally:obj.AdditiveAnimType=old_type
    print('raw_first',exporter.inspector.value_json(raw.Tracks[0]),flush=True)
    print('raw_last',exporter.inspector.value_json(raw.Tracks[raw.Tracks.Count-1]),flush=True)
