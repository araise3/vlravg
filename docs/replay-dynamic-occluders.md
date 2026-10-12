# Dynamic map occluder dependencies

`scripts/replay_dynamic_occluders.py` joins source map actors to their exact
native replay object paths. It currently covers two Ascent window shields,
Ascent breakable panels/window, two Lotus rotating doors, and the Lotus breakable
panel. Class names alone do not establish geometry or activation.

The source probe reads both gameplay levels and their map streaming declarations,
component/template metadata, full LOD0 mesh positions, and the exact installed
Blueprint programs. A nonidentity serialized level transform is rejected until
supported. The evidence matches the existing behavior-source archive inventory
and mapping hash. Original game files, replays, map exports and source caches are
unchanged.

Current immutable evidence:

- Assets: `.local/replay-transcripts/asset-research/dynamic-map-assets-v3.json`
- Sidecars: `.local/replay-transcripts/asset-research/dynamic-map-replay-evidence-v3`

Six corpus replays produced 22 actor instances and 851 source/schema-bound native
field observations, with zero unresolved measured payloads. All six source
acceptance checks passed. The asset evidence SHA-256 is
`b92477a716a70b3a768b895c2b2153fbe8d09a1303930179d039b4b1d410808d`.

## Geometry and timing contract

Each profile stores a source render component, exact serialized attachment/root
transforms, material overrides, program references, bounds and dependencies.

Ascent lift motion follows the decoded `MoveDoorToPosition` Blueprint's vector
interpolation. Its native achieved alpha and clamping are unverified. The
conservative gate therefore uses the shutter's finite XY extent and **unbounded
world Z**. `None` in both bounds entries for one axis means that axis is
unbounded. A separate finite authoring sweep supports inspection; it is not the
gating bound.

Lotus uses a full yaw sweep rather than a desired open/closed pose. Its saved
`DoorPiece1` location is -2075 cm, but `ReceiveBeginPlay` explicitly sets that
component to +100 cm. Both locations are enclosed. Ignoring that Blueprint
change would put the modeled visible door below the map. The regions enclose
converted source geometry and known program domains; they do not certify native
shader deformation, culling or playback clock parity.

Native replay manifests explicitly declare DoorState, Transition, LocalDoorPos,
DoorOpenStartTime, DoorCloseStartTime, Rotated, bHidden and IsAlive_0 export
handles/checksums. Nameless static-instance records are decoded only after an
exact actor/class join and matching class export declaration. Typed/raw payload
disagreement, padding, wrong bit counts/checksums, ambiguous actor epochs and
unowned health components remain unresolved. Numeric door enum values and
movement-clock scalars are retained without inventing native enum labels or
converting the scalar clock to replay milliseconds. Finite engine sentinels are
not achieved motion or activation times.

Actor channel epochs and each observation's replay round remain explicit.
Earlier-round flags, future fields and pre-round baseline values are not silently
reused. A channel close means loss of that channel's evidence; it does not remove
the map body. Reopening a channel discards earlier hide knowledge. Desired
DoorState or IsAlive=false never proves an open path.

## Integration API

```python
validate_sidecar(sidecar, corpus_record, assets_path, replay_path,
                 verify_parquet=True)
dependencies = region_dependencies(sidecar, eye_xyz, body_xyz,
                                   time_ms, round_index)
```

The acceptance guard verifies the helper, asset/class sources, exact export
manifest, actor/field/GUID Parquet files, decoder, viewer and source replay
identities. It also checks every source actor placement/program field.

The ray query returns `dynamic_occluder_geometry_unknown` when a segment crosses
an unresolved region. It does not declare the region an opaque wall. A decoded
current-round `bHidden=true` observation from the current unambiguous actor epoch
can omit that actor body from the display model; it still does not certify
player visibility or clear all effects/debris. Missing actor identity retains
the potential region. Coverage and native-visibility verification stay false.

In replay `161ed113-3628-49a5-835f-dbdad07fe812`, Lotus's breakable panel reports
`bHidden=true` at 123205 ms, packet 34545. A diagnostic segment through its source
bounds has a dynamic dependency at 123204 ms; the display-model body dependency
ends at the observed flag. The next round does not inherit that hide flag.

## Checks and reproduction

Thirteen regression tests use real 13.06 mesh/program fixtures and cover the
BeginPlay placement, unbounded lift axis, streaming-transform rejection, raw
schema guards, component ownership, GUID ambiguity, future/round boundaries,
channel reopening, malformed updates and desired-state uncertainty.

```powershell
.venv-replay/Scripts/python.exe scripts/test-replay-dynamic-occluders.py
.venv-replay/Scripts/python.exe scripts/probe-dynamic-map-assets.py `
  --out .local/replay-transcripts/asset-research/dynamic-map-assets-v3.json
.venv-replay/Scripts/python.exe scripts/replay_dynamic_occluders.py `
  .local/replay-transcripts/corpus/corpus.json `
  .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review `
  --assets .local/replay-transcripts/asset-research/dynamic-map-assets-v3.json `
  --out .local/replay-transcripts/asset-research/dynamic-map-replay-evidence-v3
```

The evidence outputs already exist. Re-extraction requires new versioned output
paths; neither tool overwrites existing evidence. The dependency module does
not reconstruct doors continuously or validate native visual perception.
