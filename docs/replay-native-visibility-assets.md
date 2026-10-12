# Camera, body, shader and activation asset research

Accurate native LOS remains unfinished. This pass works from the installed
game assets and the existing 33-replay corpus. Every native camera, body,
shader-opacity and activation-clock validation flag remains false. Asset
receipt checks and decoded bytecode are evidence for reconstruction, not
rendered visibility validation.

## Recovered evidence

| Area | Recovered | Still unresolved |
| --- | --- | --- |
| Camera/body core | Nine pinned Blueprint/animation packages and 98 native call sites; explicit camera, mesh, animation and pitch-component defaults | Achieved FollowRecoil camera transform, final view rotation/FOV and native graph execution |
| Agent body bindings | Inherited components for 29 observed player classes across all 33 replays; sparse CDO layouts, 620 property-copy routes and 1,374 exposed-value handlers | Native input values, node indexing/evaluation, graph state/phase/weights, component transforms and actual silhouette |
| Body assets | 60 referenced first/third-person meshes: rest skeletons, 800,210 vertices, 1,064,637 triangles, integer weights and section bone maps | Native animated pose, LOD selection, cloth, morphs and runtime section visibility |
| Material shaders | 14 materials including parents; all ten serialized SM5/SM6 resource hashes resolve to 25 installed shader groups and 140 shader records | Selected native permutation, runtime uniforms, blending and complete particle/FXC material closure |
| Shader decoding | 70 SM5 records disassembled; all 70 SM6 records resolve to 62 unique decoded programs, including 53 pixel programs | Selected permutation, runtime inputs, control flow and composited pixel opacity |
| Activation | Twelve source-bound clock/timer call sites; widget scalar data flow plus four proven smoke timer requests and inherited dispatch for six modeled classes | Native accessor return values, dispatch/render clocks and smoke expansion/extinction |
| Effect render references | 175 packages; 45 particle systems, 517 emitters, 605 LOD records and 308 dynamic-parameter module occurrences | Native emitter/LOD selection, particle ages, mesh/texture inputs and activation/render clock alignment |
| Expanded material shaders | 199 candidates plus parents: 262 materials, 444 resolved resource hashes and 2,566 unique SM6 programs | Runtime material overrides, selected permutations, uniform values, control flow and composited opacity |

`CharacterMesh0` and `CosmeticCharacterMesh3P` are distinct source bindings.
The referenced core base mesh has four LOD0 vertices and a disabled two-triangle
section. It cannot stand in for the visible agent silhouette. The cosmetic
mesh, copy-pose/post-process graph and their achieved transforms must be
resolved together.

The material reader now enables `ReadShaderMaps` before loading packages.
Leaving this disabled had produced zero decoded resources despite the cooked
shader maps being present. Shared code is resolved through the installed
`.ushaderbytecode` index and IoStore group IDs. Group sizes, offsets and bounded
DXBC/DXIL containers are checked before extraction. The implementation follows
the decoder's [shader archive index](https://github.com/FabianFG/CUE4Parse/blob/master/CUE4Parse/UE4/Shaders/FIoStoreShaderCodeArchive.cs)
and [IoStore chunk reader](https://github.com/FabianFG/CUE4Parse/blob/master/CUE4Parse/UE4/IO/IoStoreReader.cs).

Cached material `RuntimeEntries` is a fixed serialized array with repeated
property names. The evidence preserves each array index; a dictionary keyed
only by name loses scalar/vector/texture tables. Base-property override values
are retained alongside their flags and are not assumed effective merely
because a value was serialized.

The pinned `BlindsDrivenMaterialOverlay` graph writes `Alpha_ColorMult` with:

```text
AttributeFadeEndTime = engine_time_seconds +
    (AttributeFadeTime - native_time_since_last_blinded_change)
parameter = float32((AttributeFadeEndTime - engine_time_seconds) /
    AttributeFadeTime)
```

Its serialized fade duration is one second, full intensity is requested when
native `BlindManagerComponent.IsBlinded()` is true, and the requested repeating
timer period is `0.009999999776482582` seconds. These are source operands. The
viewer exposes a null parameter value because neither native blind accessor
values nor their engine-clock binding have been recovered. A stop RPC does not
supply those values, and the scalar input alone does not certify pixel opacity.

## Graph, shader and clock continuation

The pinned `BaseShooterCamera` package contains no Blueprint functions. It
inherits native `/Script/ShooterGame.ShooterCamera` and exposes transform and
spectator defaults. This identifies a concrete source boundary: its native
camera implementation and achieved FollowRecoil transform are not decoded
by reading these Blueprint defaults. The continuation records that boundary
with a null achieved transform and a false camera reconstruction flag.

The animation reader now preserves `UScriptMap` keys and values, including
`GraphAssetPlayerInformation`, node-type property maps and saved-pose maps.
The earlier dictionary/list conversion flattened these maps and lost their
keys. Across 59 referenced first/third-person and core/post-process graph
packages, the new evidence preserves 1,374 node declarations, 143 exposed
member writes and 472 native call sites, covering the same 33-replay corpus.
Member writes retain their complete struct path and expression. For example,
Cypher's graph writes spring and hat-control alpha and copies a parent mesh
pose; serialized alpha defaults cannot replace those achieved inputs.

Serialized `LinkID` operands are retained with unresolved targets. The
engine's `AnimNodeProperties` array is transient data built during class
linking, as described in the [Epic generated-class API](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/Animation/UAnimBlueprintGeneratedClass?application_version=5.5).
The report does not assume that serialized child-property order is the
native index order. Native node mapping, graph
state/phase, copy-pose source, curves and achieved component transforms still
need reconstruction before these nodes can produce a verified body pose.

The v2 graph extraction also reads `SerializedSparseClassData` from the class
default object and captures generated constant/mutable `UScriptStruct` field
layouts. Looking only on the generated class omitted this source layer. The
decoder's [class decompiler](https://github.com/FabianFG/CUE4Parse/blob/master/CUE4Parse/UE4/Objects/UObject/UClass.cs)
also combines the default object's sparse data when producing class metadata.

Across those 59 packages, the recovered tables contain 620 property-copy
routes and 1,374 exposed-value handlers. In the core graph, one serialized
route copies native `AnimationStateParams.Velocity.X` into
`__AnimBlueprintMutables.__FloatProperty_22` using `DemoteDoubleToFloat`.
Owner/struct identities, path-segment ranges, copy types, batch ordinals and
handler copy indices are preserved and checked. The core graph alone has
453 routes and 491 handlers. Handler ordinals are kept separate from native
node indices; no native state values, selected batches or execution times
are inferred.

The installed Windows SDK's `dxc.exe` disassembles all 62 unique SM6 programs.
The evidence keeps 59 pixel output-component-3 stores and their exact SSA
value dependencies. Vertex output components are retained separately and
are never labeled pixel alpha. Phi predecessors and branch instructions
remain control dependencies; the tool does not execute a selected branch.

Two simple compiled pixel paths are traced without approximating their
instructions:

- Smoke transition shader `64A04C5DCA508364D3C1BAE3B85AC7FC62451963`
  stores `saturate(cb1[5].w)`. Its reflected material buffer slot corresponds
  to the direct serialized scalar field named `Alpha`.
- Flash background shader `E882B1BE44450385BF8E0610D1590C0A81DEF878`
  stores `saturate(cb1[3].w)`, corresponding to `Alpha_ColorMult`.

Other flash variants multiply this input by UI/vertex opacity or use
texture/procedural inputs. Debug variants also select different outputs.
The saturation operation is defined in [Microsoft's DXIL specification](https://github.com/microsoft/DirectXShaderCompiler/blob/main/docs/DXIL.rst).
These compiled routes establish conditional store-value behavior. They do
not select the runtime variant, resolve a material override or establish
final framebuffer opacity. All runtime values remain null. Shared material
resource hashes retain every owner instead of overwriting parent/instance
ownership.

The smoke parent graph now has a checked event-entry and symbolic
push/pop/jump traversal. Both sides of each unresolved condition remain
reachable. Its source proves these requests:

| Dispatch point | Timer callback | Requested interval |
| --- | --- | --- |
| Start telegraph event | `ExpandSmoke` | float32 of `SmokeDelayTime` |
| `ExpandSmoke` | `DestroySmoke` | float32 of virtual `GetSmokeDuration()` |
| `ExpandSmoke` | End telegraph event | float32 of virtual duration minus `SmokeEndTelegraphDuration` |
| Early-end multicast | `DestroySmoke` | float32 of `SmokeEndTelegraphDuration`, after clearing existing handles |

BeginPlay chooses delayed telegraph or immediate expansion from the
`SmokeDelayTime > 0` condition. Expansion invokes the intro effect and expand
timeline before requesting duration timers. The timeline requests inverse
expand/contract-duration play rates. None of these values establishes the
timer manager's achieved callback time or the rendered coverage interval.
Virtual method sources and inherited serialized defaults are retained for
all six represented smoke classes. A replay channel open is explicitly not
accepted as any of these native clock origins.

The continuation source/structure audit passes and reruns DXIL disassembly against the
original direct-material compiled containers. Eleven real-asset regression tests cover disconnected
timer casts/delegates/branches, nested graph writes, additional flash opacity
inputs, sparse CDO paths/copy indices, the native camera boundary and shader phi/control dependencies. The existing 34 visibility and
effect runtime tests also pass; uncertain visibility stays unknown.

## Particle closure and HUD material binding

The bounded render-reference scan follows FXC/component classes, Blueprint
parents, widgets, typed particle systems and curves. All selected references
resolve: 175 packages contain 45 particle systems, 517 emitters and 605 LOD
records. Full object paths connect systems, emitters, LODs, required modules,
materials and dynamic-parameter modules. Short names are insufficient:
Brimstone's smoke contains fifteen distinct `ParticleLODLevel_0` objects and
two emitters named `DEBRIS`.

The evidence retains 308 dynamic-parameter module occurrences, including
their parameter names, emitter-time/particle-time choices, spawn-only flags,
value methods and baked distribution tables. Required-module delay, loop,
lifetime and stop settings are source inputs. For example, Brimstone's
`SmokeDecal` emitter has a serialized delay of `1.2999999523162842` seconds.
Its achieved activation and particle age remain null. Mesh/texture inputs,
native FXC behavior and Niagara emitter programs remain unexpanded gaps;
the selected closure is not complete rendered coverage. Third-person blind
particles are not asserted to occlude the first-person view.

The scan also checks the blind-overlay instances in `FirstPersonHUD` and
`BroadcastHUD`. Both serialize `BaseMaterial` as
`1P_HUD_FlashBackground_MI`, whose parent is `1P_FlashBackground_main`.
These were absent from the earlier direct FXC material list. The widget's
Construct entry reaches a checked conditional route:

```text
if native IsValid(MaterialInstance) is false:
    MaterialInstance = CreateDynamicMaterialInstance(BaseMaterial)
    OverlayImage.SetBrushFromMaterial(MaterialInstance)
```

The serialized image brush initially references a debug texture. That brush
does not identify the material used after the Blueprint route executes.
The exact scalar/clock proof writes the same `MaterialInstance`.

The parent material retains separate `Alpha_ColorMult` and `GlobalAlpha`
parameters. Its cooked preshader field at word offset 17 has bytecode
`[3, 2, 0, 3, 3, 0, 6]`: two `Parameter(u16)` operands followed by `Mul`,
using [Epic's preshader opcode enum](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/Shader/UE__Shader__EPreshaderOpcode?application_version=5.5).
Compiled SM6 shader `6D50E46E445885070A871353659EC2839AFDB380` stores
`saturate(cb1[4].y)`. The field correspondence gives the conditional symbolic
formula `saturate(Alpha_ColorMult * GlobalAlpha)`. Both runtime operands and
native uniform/register binding remain unknown. Other variants can have
additional UI/vertex inputs or control flow. The serialized defaults of one
do not establish runtime values or final opacity.

The expanded material extraction resolves all 444 resource hashes for
199 candidates plus parents (262 materials). All 2,566 unique SM6 programs
are decoded, including 1,781 pixel programs and 1,801 pixel component-3
stores with no unresolved SSA references. Component-3 stores can belong to
different output signatures; they are not all asserted to be composited
alpha. Existing byte-exact DXC outputs were reused only when compiled code,
tool and disassembly receipts matched; the HUD addition required 22 new
DXC executions.

The passing render audit recomputes particle links, reference coverage, HUD routes,
preshader correspondence and DXIL value slices. It also reruns each unique
SM5 disassembly (2,519 unique programs). It checks DXC output receipts without repeating DXC during
that audit. Eight additional real-asset tests guard repeated object names,
broken module links, emitter-clock disclosure, disconnected widget routes
and the extra `GlobalAlpha` operand. Native validation flags stay false.

## Evaluator changes

The current-ray report exposes the exact recorded pawn origins/yaw/pitch and
the estimated eye, FOV, stance and three capsule body points used by its model.
Their native verification flags remain false. This makes the unresolved pose
assumptions inspectable without promoting them to skeletal/camera evidence.

Possession dependencies now omit future ownership, stop and channel-close
observations. Their round cap is a knowledge boundary. It is not an inferred
unpossess event.

When an observed smoke's serialized display envelope intersects a body ray,
unverified activation or shader behavior keeps that ray uncertain before
modeled growth and after modeled expiry/channel close, through the half-open
round cap. Only center observations available at the query time are used.
The envelope is explicitly a display-shell bound; native shader coverage is
still unknown. A separate clear model ray remains usable. Formal visibility
retains its unresolved camera/body/geometry/effect dependencies.

All 33 viewer presentations were refreshed without rewriting their replay
JSON. The service cache includes the binding report and its source receipts.

## Artifacts and checks

Local artifacts under `.local/replay-transcripts/asset-research/`:

- `native-visibility-bindings-v1/bindings.json`: core bindings, native calls,
  activation call expressions and exact widget scalar proof.
- `native-body-bindings-v1/bindings.json`: observed player classes, inherited
  components, per-property sources and referenced mesh/animation packages.
- `native-body-assets-v1/index.json`, compressed package exports and `.npz`
  files: rest skeletons, geometry, raw integer weights and local/global bones.
- `native-visibility-materials-v1/materials.json` and `shaders/`: material
  parent/override/parameter evidence, shader-map matches, bytecode and SM5
  disassembly with byte-exact receipts.
- `native-visibility-assets-audit-v1.json`: passing source/structure/receipt
  audit for all of the above; native visibility remains unvalidated.
- `native-animation-graphs-v2/graphs.json` and compressed package exports:
  source maps, sparse CDO data, generated struct layouts, checked copy routes,
  handlers, unresolved links and exposed member writes. This supersedes v1.
- `native-shader-inputs-v1/inputs.json` and `.dxil.txt` files: exact decoded
  programs, pixel value slices, conditional scalar routes and tool receipts.
- `native-activation-clocks-v1/clocks.json`: smoke event/interval proofs,
  symbolic reachability and per-class virtual method/default sources.
- `native-continuation-audit-v2.json`: passing reproducibility audit for the
  continuation artifacts, with all native validation flags false.
- `native-effect-render-closure-v1/closure.json`: full particle object links,
  emitter/module clock inputs, material candidates and HUD instance defaults.
- `native-effect-materials-v1/materials.json`: expanded material/parent and
  compiled shader archive evidence.
- `native-effect-shader-inputs-v2/inputs.json`: decoded expanded SM6 programs,
  output value slices, resource owners and byte-exact decode-cache receipts.
- `native-widget-material-route-v1/route.json`: checked HUD instance/material,
  image, scalar and conditional two-parameter compiled route.
- `native-render-bindings-audit-v1.json`: source/structure/compiled-input audit
  for these render artifacts.

`verify-native-visibility.py` also checks ten real replay clips, including pose
disclosures, null material values, causal possession evidence and smoke
dependencies at observed opening, modeled expiry and the round cap. Those
reports are under `.local/replay-transcripts/visibility-native-work-2026-10-03/`.
They test reconstruction against source-bound inputs; they do not compare
native rendered frames.

Reproduce the asset work with these scripts (their `--help` lists required
source/model paths):

```powershell
.venv-replay/Scripts/python.exe scripts/build-native-visibility-bindings.py --help
.venv-replay/Scripts/python.exe scripts/build-native-body-bindings.py --help
.venv-replay/Scripts/python.exe scripts/inspect-native-body-assets.py --help
.venv-replay/Scripts/python.exe scripts/inspect-native-visibility-materials.py --help
.venv-replay/Scripts/python.exe scripts/verify-native-visibility-assets.py --help
.venv-replay/Scripts/python.exe scripts/inspect-native-animation-graphs.py --help
.venv-replay/Scripts/python.exe scripts/inspect-native-shader-inputs.py --help
.venv-replay/Scripts/python.exe scripts/build-native-activation-clocks.py --help
.venv-replay/Scripts/python.exe scripts/verify-native-continuation.py --help
.venv-replay/Scripts/python.exe scripts/test-native-continuation.py
.venv-replay/Scripts/python.exe scripts/inspect-native-effect-render-closure.py --help
.venv-replay/Scripts/python.exe scripts/inspect-native-effect-materials.py --help
.venv-replay/Scripts/python.exe scripts/inspect-native-effect-shader-inputs.py --help
.venv-replay/Scripts/python.exe scripts/build-native-widget-material-route.py --help
.venv-replay/Scripts/python.exe scripts/verify-native-render-bindings.py --help
.venv-replay/Scripts/python.exe scripts/test-native-render-bindings.py
```

Next asset work is to bind native graph inputs and evaluation order to the
agent meshes, recover achieved inputs and runtime material instances, expand
mesh/texture/Niagara/native render dependencies, evaluate selected shader
inputs/control flow, and bind native dispatch/render clocks.
The recovered rest geometry and compiled variants do not close those gaps.
