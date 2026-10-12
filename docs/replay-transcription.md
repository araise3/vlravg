# Local replay transcription and viewer

For replay-independent asset discovery and the shared behavior evaluator, see
[replay-behavior-engine.md](replay-behavior-engine.md).

Builds the minimap, approximate observer-view diagram, static sightline colors,
turn-speed timeline, shot/death markers and plain text shown in the reference
video. This is a local tool; it requires no match API, game account credentials,
model service or website upload. The generated HTML contains its data, minimap
and triangle BVH, and works in a current browser without a server or CDN.

The main figure follows the reference video's 1200 × 750 composition: white
paper, square-edged minimap and pale-blue approximate view, status badges,
heading dial, wall-hit annotation and a timeline. A fifth purple row shows the
separate smoke model. The native-resolution
layout scales as one figure. Controls, event selection and exports are below it;
Space toggles playback when the figure is focused. Blue marks the observer's
team, and red marks its opponents; original Blue/Red team identities remain in
the exports. The long black timeline band is the selected candidate's review
context, not the duration of its measured turn.

DejaVu Sans is bundled locally to match the reference typography. Its unmodified
font and license are in `scripts/replay-font/`; the license is also included in
the standalone viewer's data bundle. Source:
[Matplotlib 3.10.0 font assets](https://github.com/matplotlib/matplotlib/tree/v3.10.0/lib/matplotlib/mpl-data/fonts/ttf).

The supplied Abyss replay `8dac718f-24f5-4042-99a7-4a2a27f2d22f` decoded on build
13.06: Blue 13–Red 8, 21 played rounds, 162 deaths, 2,394 observed gun discharges,
2,153,502 native movement rows. All killer/victim joins resolve. Two kills meet
the explicit rapid-turn retrieval policy. These are review candidates, not
classifications of player intent.

The game asset pass adds 125 smoke-zone actors (all instigators resolved),
Omen/Jett/Astra/recall profiles, and their actual 1,056-triangle hollow blocking
mesh. Expansion and decay use decoded Blueprint timeline links and extracted
linear/constant/cubic curves. World FOV uses 685 recorded target settings, with
322 observations joined to the selected weapon; camera transitions use a
labeled linear estimate. There are 4,312 recorded crouch-input changes, retained
as input evidence rather than achieved stance.

## Run on this workstation

The `.tools/vrfkit-transcription` decoder is pinned to
`c4d6cc0e5ec3904fdb64b350b2656b8e3ff33d53`, separately from the older replay tools.
The existing project-local Rust toolchain, Visual C++ tools, FModel/CUE4Parse,
portable .NET 10 and pythonnet are used. `setup-transcription.ps1` installs the
Python requirements and checksum-verifies the 13.06 mapping; it does not install
or change the game. On a fresh workstation, stage the existing FModel runtime
and map Python libraries before map extraction.

```powershell
.\scripts\setup-transcription.ps1
.\scripts\build-replay-transcription.ps1 `
  -ReplayPath 'C:\path\to\match.vrf'
```

For the already extracted Abyss map:

```powershell
.\scripts\build-replay-transcription.ps1 `
  -ReplayPath 'C:\path\to\match.vrf' `
  -MapDirectory '.local\replay-transcripts\abyss-map'
```

`-ExtractMap` refreshes the map asset export. The wrapper validates and exports
each replay into a new run directory, leaving its original VRF untouched. Its
source-provenance file records replay/executable SHA-256 and parser revision.
It pins mappings to 13.06 and refuses a different replay build. Minimap coordinate
transforms and names now come from installed map UIData. The corpus supports
Abyss/Infinity, Summit/Plummet, Split/Bonsai, Lotus/Jam, Haven/Triad,
Sunset/Juliett and Ascent. See [the corpus workflow](replay-corpus.md) for folder
processing, expanded asset metadata, native blind records and coverage totals.
The wrapper also extracts an inherited gameplay asset model into each run.
`-AssetModelPath` reuses an existing model; mappings and IoStore hashes must match
the map export. The asset inspector enables CUE4Parse's `ReadScriptData` switch
for model exports, then follows Blueprint parents, curve references and the
blocking shell mesh. This reads assets and does not launch or attach to the game.

For an existing export:

```powershell
.venv-replay\Scripts\python.exe scripts/build-replay-transcription.py `
  .local/replay-transcripts/<match-id>/export `
  --map .local/replay-transcripts/abyss-map `
  --asset-model .local/replay-transcripts/game-asset-model.json `
  --out .local/replay-transcripts/<match-id>/review
```

To regenerate the asset model independently:

```powershell
.venv-replay\Scripts\python.exe scripts/inspect-transcription-assets.py `
  --out .local/replay-transcripts/asset-research/model-source.json `
  --model .local/replay-transcripts/game-asset-model.json
```

`model-source.json` retains serialized properties and decoded Kismet expressions.
The compact model records each inherited property's source, mapping SHA-256,
IoStore inventory hashes, shell vertices/indices and behavior evidence. The
builder records its SHA-256 in `provenance.json`. Asset/replay build parity remains
unverified. CUE4Parse's script-reading option is documented in its
[UStruct implementation](https://github.com/FabianFG/CUE4Parse/blob/master/CUE4Parse/UE4/Objects/UObject/UStruct.cs).

Outputs: `viewer.html`, `transcript.txt`, `events.jsonl`, `replay.json` and
`provenance.json`. All player data stays under gitignored `.local/`. The JSON
contains sampled movement tracks, exact event times, turn measurements,
limitations and parser/asset diagnostics. JSONL contains event evidence with a
metadata header. Text covers all decoded events and gun discharges, not only
the selected clip. These exports can be supplied to a model separately; this
tool makes no model/API call.

Open `viewer.html` directly for the overview. To use the replay library and
original-movement visibility analysis, start the local service:

```powershell
.venv-replay\Scripts\python.exe scripts/serve-replay-library.py `
  .local/replay-transcripts/corpus/corpus.json `
  .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review --port 8769
```

Moment clips automatically analyze the selected directed pair using original
movement timestamps and observed effect boundaries. Full rounds use the
**Analyze original movement** button. Jobs are bounded to five-minute windows,
run one at a time, and cache by request and source hashes. Changing the pair,
window or model options discards any previous UI result. The visibility JSON
preview is a summary; its download retains the complete samples and evidence.

The queue switches between rapid-turn candidates and all deaths. Choose a
round, observer or opposing target, play at 0.1–2× speed, step 50 ms, drag the
timeline, or jump to just before death. Kill clips focus the map around the
fight; **Full map** restores the overview. Click a minimap player to observe,
or Shift-click an opponent to target. Space plays/pauses; arrow keys step when
outside form controls. Names can be assigned to UUID-backed slots and are
included in downloads as user annotations. `--names names.json` also accepts
an explicit `{ "account UUID": "name#tag" }` mapping.
**Smoke model** toggles purple map circles, view illustrations, the model badge
and the smoke timeline. The upper wall-ray timeline remains separate. The model
is exported regardless of this display toggle. JSON/JSONL include observed zone
events, moving zone centers, ownership joins, FOV observations and raw selected-
weapon/crouch-input timelines; text includes zone observations and model results
at deaths.

## Evidence boundaries

- Event times use the replay clock, not client input/display timing. Shots come
  from gun firing-effect RPCs with a firing player, weapon, attack vector and
  projectile count. Checkpoint observations do not create new shot events.
- Native movement is used for the measured turn: at least 45° within 100 ms,
  no sample gap over 50 ms, ending within 500 ms of a kill, target-center aim
  angle at most 20°, and at least 25° reduction in that angle. Playback uses
  actual observed poses at 50 ms intervals, not extrapolated movement.
- Static rays use all always-loaded art levels, opaque material sections,
  component/instance transforms and nearest 3D triangle hits. Buy barriers,
  blockout, nav meshes, collision helpers and inactive dynamic levels are
  excluded. Extracted map triangles: 3,708,765; the supplied replay's view
  includes 1,725,501 triangles within the recorded movement area.
- Player defaults come from inherited `BasePawn` / `BasePlayerCharacter` assets:
  standing eye 77 cm, crouched eye 30 cm, crouch time 275 ms, capsule half-height
  98 cm and radius 42 cm. The three wall-ray points are the capsule center and
  cap centers (±56 cm), not animated hitboxes. The crouch toggle applies an
  explicitly labeled input-driven asset model: 275 ms for a full transition,
  continuous partial reversals, and eye height 77→30 cm. The lower proxy sample
  rises by the 20 cm compression, the upper sample follows the eye-height change,
  and the middle sample lies between them. This is a diagram proxy, not a decoded
  crouched capsule or skeleton. Recorded XYZ already contains compression and is
  never lowered again. Blocked input and achieved stance are not decoded.
  The replay independently corroborates ±20 cm in all 65 eligible stationary,
  isolated, living-player transitions (≤0.5 cm XY range over the audit window).
  `camera.crouch_corroboration` retains their native-position evidence; this audit
  does not certify every modeled pose. Aim-center measurements use the same eye
  model, while turn angles still come directly from native yaw/pitch.
- World FOV follows `AresInventory.NewCurrentEquippable` and its zoom component's
  `SourceFov` / `TargetFov`; `SourceFov1P` / `TargetFov1P` describe the weapon mesh
  and are retained separately without changing world projection. The newer inventory field agrees with 2,391 of 2,394 observed
  gun discharges in this replay; the older field agrees with 1,647. Transition
  duration is recorded, but interpolation is an estimate. With no usable current
  setting the viewer labels its 103° fallback. Camera aspect is 16:9.
- Smoke sphere defaults are Omen 410 cm, Jett 335 cm, Astra 475 cm and Astra recall
  475 cm. Shell ray tests use the actual mesh, the inherited component hierarchy
  and per-profile scale, rather than just those spheres. Occupancy and boundary
  crossing are separate: two points within a hollow sphere are not automatically
  marked as a boundary crossing. Shell triangles are double-sided in this model;
  native backface/vision-channel rules still need validation.
- The decoded parent Blueprint scales `SmokeScene` by its timeline percentage,
  with play rate `1 / SmokeExpandDuration` or `1 / SmokeContractDuration`. The
  destruction timer begins with expansion, so expansion overlaps duration.
  Jett's duration override reads an ability tuning component; the model currently
  uses its 2.5-second serialized default. Actor openings/closures bound each
  model interval, but channel visibility is not proof of activation/destruction.
  Purple circles and projected smoke shapes illustrate the model, not a rendered
  smoke shader. Recorded Jett smoke-interior effects are now extracted separately
  from estimated geometric smoke occupancy.
- Vision effect intervals join `MulticastPlayContinuousEffect.EffectContainer`
  to asset class GUIDs and the enclosing actor to the affected player. Stops must
  match actor, component, source ID and effect ID; overlapping effects remain
  separate. Multiple calls within one packet retain Parquet order. Missing stops
  are capped at round boundaries and explicitly labeled; asset duration is not
  substituted. The supplied replay now has 45 intervals with matching stop RPCs:
  the original 7 Omen Paranoia, 9 Reyna Leer and 16 Jett smoke-interior nearsights,
  plus 13 Waylay RewindTime nearsights identified through native asset inheritance.
  The Vision effects queue jumps to these intervals, including sub-50 ms ones.
  Start/stop movement timestamps and packet IDs remain in JSON, but playback uses
  replay observation time, not an inferred client display clock.
- Flash profiles follow the shipped BlindConfig assets to their exact effect
  classes for Breach, KAY/O, Skye, Vyse, Phoenix and Yoru (including clone).
  Conventional flash decoding uses the same recipient interval path. This match
  has none. The expanded corpus includes 710 flash intervals, with a real replay
  fixture exercising native Phoenix full/glance blind IDs, durations and removals.
  The optional light flash cue and colored nearsight vignette are illustrations:
  native BlindManager intensity, shader radii, dynamic fade and effect tails are
  not reconstructed. Asset colors and nearsight defaults remain in provenance.
- Wall/smoke results **do not certify what was visible** through flashes, reveals,
  masked surfaces, camera animation, recoil or dynamic walls. Runtime tuning,
  native camera behavior and synchronized perception still need validation.
- Installed assets decoded with the 13.06 mapping, but mapping compatibility
  does not certify that every installed mesh matches the replay build. The
  output retains `asset_build_verified_against_replay: false` and
  `geometry_complete: false`, with IoStore inventory and geometry hashes.
- Native DamageableComponent alive flags drive life state when available,
  including later revivals. Death events provide a fallback when no alive flag
  exists for that round. Resurrection broadcasts remain separate evidence.
  Display names
  are not recovered from this replay; UUIDs and slot labels remain authoritative.
- This export has zero overlay decode errors and zero structural/transform
  losses reported by validation, but 9,193 unresolved RPC payloads are preserved.
  Successful parsing does not establish complete gameplay semantics.

Mappings and public asset key:
[UEDB VALORANT](https://uedb.dev/game/valorant), with the 13.06 ZStandard mapping
SHA-256 `5555dd628883df9d9f68272a2099e4f7bfc15bcdcc8cb9bf31216a61bb1174dc`.
Parser: [vrfkit](https://github.com/yakisoba0728/vrfkit).
Agent labels in the corpus model come from 30 installed agent UIData assets;
28 agent codes occur in these replays. No runtime match-data service is used.

## Validation

```powershell
.venv-replay\Scripts\python.exe scripts/test-replay-transcription.py
.venv-replay\Scripts\python.exe scripts/test-replay-asset-model.py
.venv-replay\Scripts\python.exe scripts/test-replay-status.py
.venv-replay\Scripts\python.exe scripts/test-replay-observations.py
node tests/replay-transcription-viewer.test.cjs
```

Checks cover nearest wall hit, segment endpoints, partial body coverage,
binary BVH interoperability, camera/FOV axes, yaw wrap, nearly vertical aim,
missing movement, turn windows and round boundaries. Asset tests also cover smoke
ownership, curved envelopes, shell intersections, hollow interiors, closure/round
bounds and world/weapon FOV separation. Status checks cover effect recipient and
source identity, overlapping flash/nearsight IDs, same-packet calls, reused IDs,
missing stop/round boundaries, interrupted crouch transitions and camera/body
projection without applying native XYZ compression twice. Observation checks
cover a real 13.06 blind-array fixture, exact recipient/ID joins, invalid-delta
baseline loss, bounded bit reads, raw effect updates/one-shots and GUID cycles.
Browser checks cover library filtering, flash transcription, montage metadata,
active-weapon zoom and history seeking. The complete wrapper was run against the
supplied replay with fresh decoding and asset extraction; the result was reviewed
in the browser. Geometry/perception accuracy
still requires a synchronized first-person recording; synthetic tests do not
certify it.
