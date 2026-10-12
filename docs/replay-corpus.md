# Entire local replay folder

The 2026-10-02 pass covers all **33 VRFs** in the supplied Demos folder, all on
13.06, across seven maps. Each source has a SHA-256, decoder SHA-256, validation
log, export manifest and field/class inventory. Source files are read-only.
This version is `replay-transcription` 0.4.0. See
[replay-transcription.md](replay-transcription.md) for initial setup and the
geometry, stance and smoke model boundaries.

Installed-build discovery, the shared frame evaluator and dependency coverage
are documented in [replay-behavior-engine.md](replay-behavior-engine.md). These
operate independently of which interactions occur in this replay corpus.

The library retains:

| Evidence | Count |
| --- | ---: |
| Native movement rows in source exports | 68,101,936 |
| Effect RPC observations during played rounds | 1,082,232 |
| Continuous effect starts | 317,454 |
| Animation-related field observations | 43,403 |
| Camera-field observations | 163,614 |
| Flash intervals | 710 |
| Nearsight intervals | 1,174 |
| Resurrection broadcasts | 111 |
| Unresolved RPC payloads preserved | 223,451 |

Camera observations include AnimatedZoom as raw/typed native fields; the renderer
applies the active weapon's usable world-FOV settings. World and weapon FOV
streams remain separate. Effect intervals are bounded by played rounds; history
uses round assignments, and complete native fields remain in the source exports.

Native blind membership is decoded only under validated 13.06 framing. Affected
actor, component, round, source ID and effect ID must agree before a blind record
attaches to a vision interval. Config paths and reported initial durations are
retained; a native array removal and a matching effect stop are different
observations. One unresolved blind delta loses its baseline rather than
fabricating array members. Remaining scalar records stay in the exports.
There are 771 native blind memberships: all 710 player flash intervals have
matching records; 61 other memberships affect ability actors such as cameras,
drones, seekers and decoys. **Native blind records** in the history panel exposes
both groups, array observations and duration scalars without assigning a player
identity to those actors.

The installed asset catalog contains **8,203 typed effect/animation entries**,
including **5,440 animation assets**, 24 inherited vision profiles and 30 agent
names. All referenced nested montage/sequence/blend-space packages were followed;
the metadata catalog has no outstanding animation-reference dependencies and
asset inspection reported no failed packages. Montage length, slots, sections,
blends, skeleton references and notifies are inspectable. Animation-related
booleans and raw records are observations, not proof an animation played.

The structural readers ran on every replay. Thirty-one have no reader rejections;
two have three volume declarations rejected as `unvalidated_build`. Their
successfully decoded volume cells remain available alongside rejection receipts
and the raw export. Numeric ability-state structures, ground-volume polygons,
world-effect actors and actor tracks are downloadable from each **Coverage** page.
Unpaired effect stops/updates and unresolved RPCs are counted and preserved.
Parsing coverage does not establish gameplay semantics.

The viewer has a replay selector and an **Effects, animations and camera history**
panel with category, asset/field search, actor scope, pagination, timestamp seeking
and parameter/asset inspection. Native skeletal blending, exact shader opacity
and fades, recoil, shake, camera animation and unknown ability semantics remain
unresolved. The geometry/stance/smoke/vision diagram labels its approximations.

## Rebuild the folder

On this workstation:

```powershell
$review = '.local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review'
.venv-replay/Scripts/python.exe scripts/build-replay-corpus.py `
  'C:/Users/leona/AppData/Local/VALORANT/Saved/Demos' --jobs 2
.venv-replay/Scripts/python.exe scripts/build-replay-corpus-extras.py `
  .local/replay-transcripts/corpus/corpus.json --out "$review/library" --jobs 2
.venv-replay/Scripts/python.exe scripts/build-replay-library.py `
  .local/replay-transcripts/corpus/corpus.json --out $review `
  --asset-model .local/replay-transcripts/corpus-asset-model.json --jobs 2
.venv-replay/Scripts/python.exe scripts/serve-replay-library.py `
  .local/replay-transcripts/corpus/corpus.json $review --port 8769
```

Open `http://127.0.0.1:8769/library.html`. Corpus decoding reuses exports when
source and decoder hashes agree. Viewer receipts also key map, model and
implementation hashes. Additional-reader receipts retain their own input hashes
and rejected-record counts. On Windows, private staging-directory ACLs may require
running the reader/server as the normal desktop user. Check written receipts for
partial decoding when a reader returns nonzero.

## Discover and inspect newly observed assets

Package discovery reads each replay's GUID paths, effect/animation fields and
player-body class declarations:

```powershell
.venv-replay/Scripts/python.exe scripts/discover-replay-assets.py `
  .local/replay-transcripts/corpus/corpus.json `
  --out .local/replay-transcripts/asset-research/discovery
.venv-replay/Scripts/python.exe scripts/inspect-transcription-assets.py `
  --packages-json .local/replay-transcripts/asset-research/discovery/effects-packages.json `
  --follow-inheritance --follow-animations `
  --out .local/replay-transcripts/asset-research/discovered-effects.json
.venv-replay/Scripts/python.exe scripts/inspect-transcription-assets.py `
  --packages-json .local/replay-transcripts/asset-research/discovery/animations-packages.json `
  --follow-animations --out .local/replay-transcripts/asset-research/discovered-animations.json
.venv-replay/Scripts/python.exe scripts/inspect-transcription-assets.py `
  --packages-json .local/replay-transcripts/asset-research/discovery/agents-packages.json `
  --out .local/replay-transcripts/asset-research/discovered-agents.json
.venv-replay/Scripts/python.exe scripts/build-replay-asset-catalog.py `
  .local/replay-transcripts/asset-research/discovered-effects.json `
  --animations .local/replay-transcripts/asset-research/discovered-animations.json `
  --agents .local/replay-transcripts/asset-research/discovered-agents.json `
  --base .local/replay-transcripts/game-asset-model.json `
  --out .local/replay-transcripts/corpus-asset-model.json
```

`--catalog-source` on discovery includes animation references from earlier
inspections. `--follow-animations` follows them recursively. `--animations` on the
catalog builder can be repeated to merge multiple passes. All archive inventories
must agree. For a newly encountered map, run `export-transcription-map.py --map
<package-code> --out .local/replay-transcripts/map-<package-code>-13.06` before
building the library. The original Infinity corpus map uses `abyss-map`.

The current catalog was built from `corpus-asset-catalog-source.json`,
`corpus-animations-source.json`, `corpus-nested-animations-source.json`,
`corpus-agents.json` and `game-asset-model.json` under `.local/replay-transcripts`.
All newly discovered native effect/animation package references are present in
the inspected sources. Two ping-marker packages are inspected but have no typed
effect/animation entry.

## Checks

```powershell
.venv-replay/Scripts/python.exe scripts/test-replay-transcription.py
.venv-replay/Scripts/python.exe scripts/test-replay-asset-model.py
.venv-replay/Scripts/python.exe scripts/test-replay-status.py
.venv-replay/Scripts/python.exe scripts/test-replay-observations.py
node tests/replay-transcription-viewer.test.cjs
```

The native fixture checks Phoenix full/glance blind IDs, durations, array removals,
exact actor/source/effect joins and baseline loss after corrupt deltas. Viewer
checks cover revival after an observed death and separate world/weapon FOV.
Browser verification exercises library filtering, real flash transcription,
montage metadata and a recorded world-FOV transition from 103° to 82.4°.
