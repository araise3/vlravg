# Asset-driven behavior reconstruction

The installed build now provides the discovery baseline. Replay examples are
used to check decoded observations rather than to decide which behaviors exist.
The original stats site and its API are independent of these local tools.

## Pipeline

`discover-installed-behaviors.py` reads the export headers of every mounted
`.uasset` and `.umap`. It records export classes and generated-class parents
without deserializing render bulk data. The cooked asset registry is retained
as supplementary metadata: this build's registry does not list every package.
Headers containing generated classes or functions feed the behavior scan.
Textures, animation sequences, curves and materials are also counted by their
actual export classes, even when they have no Blueprint program.

`inspect-installed-behaviors.py` reads serialized defaults, components, class
metadata and Blueprint functions in those behavior packages. It retains source
programs and references in a gzip record per package. It omits mesh, texture,
sound-wave and animation-sequence bulk exports. These omissions are recorded;
sequence bulk data is handled by the animation export described below. Shader
execution remains separate work.

Both scans fingerprint archives, mappings and their code. A changed fingerprint
requires a fresh output directory. Header scanning repairs a torn last JSONL
line; source records have hashes and are only reused when their bytes agree.
Parse failures, depth-limited properties and non-finite numeric sentinels remain
explicit gaps. No missing value is converted to zero or a fabricated default.

`build-behavior-coverage.py` reports four distinct stages:

- discovered packages and functions from headers;
- decoded exports and any failures;
- functions whose expressions and calls fit the evaluator subset;
- exact extracted programs checked by fixtures.

The report includes opcode gaps, native calls, dynamic dispatches and missing
package references. Empty event/delegate functions count as expression support,
so this count is not a percentage of implemented gameplay. A function within the
subset can still fail at runtime when an input or object binding is missing.
Fixture checks are required before the coverage artifacts are written. They
verify our modeled evaluator, not native-engine visual parity.

The builder also compiles final Blueprint call dependencies into a registry
keyed by actual function object paths, retaining signatures and source hashes.
A caller is excluded when any dependency cannot be compiled; receiver-dependent
virtual dispatch remains a binding gap. The 13.06 registry contains 5,482
programs, including 191 that resolve additional asset calls. Its 40,561 checks
verify dependency closure, exact fixture bytecode, a real nested callback and
atomic failure with a removed dependency. This is support for an expression
subset, not 5,482 automatically reconstructed gameplay behaviors.

## Shared evaluator

`replay-behavior-runtime.js` has an explicit Blueprint expression interpreter.
It supports constants, variables, assignments, conditional/computed jumps,
execution-flow stacks, returns, context access and a small list of modeled
native bindings. Final calls use their exact target; virtual calls traverse an
explicitly bound receiver class hierarchy. Function signatures bind parameters,
local values and out/reference aliases. Persistent frames belong to explicit
object IDs and function paths. Unsupported native implementations, unbound
objects, invalid inputs, recursive-call limits and execution-budget exhaustion
discard the entire call tree's mutations and staged commands.

Extracted smoke-duration, smoke-scaling, audio-perspective and default death-reaction functions are
fixtures. The smoke-scaling fixture proves that the same program accepts varying
scale values; it does not prove the activation clock, runtime tuning, transforms
or shader behavior of every smoke actor. Additional fixtures check real smoke
expansion/contraction callbacks through nested dispatch and persistent event
graphs. Event sessions rebuild from a seed and an ordered, explicitly supplied
event log when seeking. They do not synthesize native ticks, timers or latent
continuations. Automatic replay invocation still needs those clocks and object
bindings; animation graphs, materials and most ShooterGame calls remain gaps.

The extracted shared flash Blueprint reads the blind manager's longest active
duration. A binding supplies its recorded scalar at or before the sampled time,
including an observed zero. It does not recompute a guessed maximum from blind
intervals. Array membership is reconstructed in packet/time order and matched
to the same actor and component; final future members never leak into a prior
frame. The native accessor's implementation and flash shader fade are unverified.

The viewer also uses a common frame evaluator. It samples posture, active-weapon
world/mesh FOV, life state, vision memberships and named continuous effects at
one replay timestamp. Effects retain their individual IDs and intervals; one
source ending cannot remove another source's effect. Native starts/stops and
life flags remain observations. Death does not invent a universal effect reset.
Posture and FOV transitions remain the explicitly labeled existing models.
The evaluator carries no mutable playback state between frames, so backward
seeks cannot leak future state. Round boundaries exclude previous-round posture,
effect memberships and weapon-selection observations.

Open **Effects, animations and camera history → Current behavior layers and
unresolved dependencies** in a replay to inspect the composition. The installed
behavior coverage page is linked from the library and every replay. This does
not imply that all discovered programs are automatically invoked by the viewer:
their input bindings and invocation clocks still need implementation.

## Installed animation assets

`export-installed-animations.py` selects every sequence, montage, composite,
blend-space, aim-offset and skeleton package in the header inventory. The
installed CUE4Parse converter decompresses sequence tracks without dropping
keys. Records retain independent/shared key times, translations, scales,
four-component quaternions, the converter's basis pose and skeleton hierarchy.
Montage and blend-space metadata remains inspectable. Raw additive tracks are exported separately so the installed converter’s already-applied base is never applied twice. Every gzip record and
dependency has a hash. Unsupported exports remain explicit errors.

`replay-animation-runtime.js` samples these tracks and composes skeleton poses.
`check-replay-animation.cjs` compares each sequence's selected bone samples at
the start and an intermediate frame with the installed converter's
`GetBoneTransform` outputs, and verifies record hashes and skeleton structure.
Quaternion comparisons use orientation: the converter's approximate
normalization can change quaternion magnitude without changing rotation.
These checks validate converted track sampling, not Unreal's native pose pipeline. The installed converter references use linear key sampling; the step-mode tests separately verify held-key boundaries according to the asset interpolation flag. See [Epic’s interpolation documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-sequence-editor-in-unreal-engine).

`build-animation-library.py` runs those checks before publishing a local
searchable preview. Replay animation records link to their referenced assets.
The preview plays a selected asset with a local clock. Replay graph activation,
native blending, mesh retargeting and root motion still require bindings. Explicit local-space and mesh-space additive composition is implemented at full weight, with independent installed decoder references. The preview offers the stored authoring reference or an explicitly chosen skeleton rest base. That authoring reference is not evidence of the runtime graph’s base pose. Partial additive weights remain explicit gaps. Sequence gameplay notifies and curve-driven behavior are not executed. Active montage notify intervals are displayed without invoking their native effects. An asset preview is not a reconstructed player pose.

The complete 13.06 animation pass inspected 21,363 packages and decompressed
13,680 sequences. Eighteen sequences have a converter retarget-basis/skeleton
count mismatch and remain explicit export failures. Of the decoded sequences,
8,353 pass absolute-pose preview checks; all 5,327 additive sequences now have separately decompressed raw delta tracks and composition reference samples. The three step-interpolated absolute clips now hold key values until the next key. Independent reference samples pass
614,760 checks, with exact translation/scale agreement after matching the
converter's single-precision clock convention. No native graph parity is implied.

`export-additive-animation-tracks.py` uses the pinned installed decoder’s raw UE compression or native ACL ABI. The UE conversion flag changes only on a deserialized object and is restored in `finally`. ACL operates on a private allocated copy. Omitted additive scale channels use the zero delta identity; encoded scale keys are preserved. `check-additive-animation.cjs` checks raw sampling, full-weight local/mesh composition against independent .NET reference samples, all-bone pose validity, record hashes and explicit missing-base failure. The original converted cache remains immutable.

Montage previews resolve the asset’s stored slot, trimmed segment, play rate, loop count and section links. Section cycles are reduced mathematically, so long playback and backward seeks produce the same clock without a mutable event history. The slot is selected explicitly. Native slot blending and gameplay section overrides remain unbound. Overlapping segments and invalid/missing references produce explicit gaps.


`export-blendspace-metadata.py` reads typed arrays directly, retaining both axes and all three indices/weights in each grid node. The original generic property dictionaries collapsed static-array entries and remain preserved as historical metadata. All 699 blend-space packages were inspected: 697 produced typed metadata; two lack complete axes. Of those, 691 support the stored-grid weight evaluator. Five grid shapes are ambiguous and one axis is invalid; these remain explicit gaps. No square-grid dimensions are guessed. The validator checks 549,546 grid nodes against their complete serialized weights (2,384,116 checks).

The blend-space preview selects instantaneous grid weights from explicit input values. It combines sample transforms at an explicit normalized phase; additive deltas are combined before applying one explicit base. Distinct authoring bases, mixed additive spaces, missing samples and incompatible skeletons remain gaps. This preview does not validate native pose blending, input filters, sample-weight smoothing, per-bone overrides, sync markers or the runtime blend-space phase clock. Sample rates are retained as metadata; the normalized phase preview does not invent those clocks.

## Local commands

Run from the repository with the staged replay Python/.NET/CUE4Parse tools:

```powershell
.venv-replay/Scripts/python.exe scripts/discover-installed-behaviors.py --out .local/replay-transcripts/asset-research/installed-behaviors
.venv-replay/Scripts/python.exe scripts/inspect-installed-behaviors.py .local/replay-transcripts/asset-research/installed-behaviors --out .local/replay-transcripts/asset-research/installed-behavior-source-v5
.venv-replay/Scripts/python.exe scripts/build-behavior-coverage.py .local/replay-transcripts/asset-research/installed-behaviors .local/replay-transcripts/asset-research/installed-behavior-source-v5 --out .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review/behavior-coverage
.venv-replay/Scripts/python.exe scripts/export-installed-animations.py .local/replay-transcripts/asset-research/installed-behaviors --out .local/replay-transcripts/asset-research/installed-animation-tracks-v3 --jobs 4
.venv-replay/Scripts/python.exe scripts/export-additive-animation-tracks.py .local/replay-transcripts/asset-research/installed-animation-tracks-v3 --out .local/replay-transcripts/asset-research/additive-tracks-v1
.venv-replay/Scripts/python.exe scripts/export-blendspace-metadata.py .local/replay-transcripts/asset-research/installed-animation-tracks-v3 --out .local/replay-transcripts/asset-research/blendspace-metadata-v1
.venv-replay/Scripts/python.exe scripts/build-animation-library.py .local/replay-transcripts/asset-research/installed-animation-tracks-v3 --additive-source .local/replay-transcripts/asset-research/additive-tracks-v1 --blend-source .local/replay-transcripts/asset-research/blendspace-metadata-v1 --out .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review/animation-assets
node --test --test-isolation=none tests/replay-behavior-runtime.test.cjs tests/replay-animation-runtime.test.cjs tests/replay-transcription-viewer.test.cjs
.venv-replay/Scripts/python.exe scripts/test-replay-behavior-assets.py
.venv-replay/Scripts/python.exe scripts/audit-replay-library.py .local/replay-transcripts/corpus/corpus.json .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review --animation-source .local/replay-transcripts/asset-research/installed-animation-tracks-v3 --additive-source .local/replay-transcripts/asset-research/additive-tracks-v1 --blend-source .local/replay-transcripts/asset-research/blendspace-metadata-v1 --out .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review/behavior-coverage/final-audit.json
```

`--limit` on either scan bounds one invocation; a subsequent run resumes against
the same fingerprints. All generated inspection data stays in ignored `.local`.
The game files and source replays are read-only.

`build-replay-library.py --presentation-only` refreshes all viewer code while
retaining the exact compressed data/geometry. It requires unchanged source,
map and model hashes and preserves the previous backend hashes in receipts.
A later full build still detects changed backend code normally.

## Interaction validation and remaining work

`check-replay-behavior.cjs` generates 256 layer combinations with exact boundary
and reverse-seek checks: two flashes, nearsight, crouch reversal, interrupted
zoom, weapon swaps, death/revival and same-frame starts. It separately checks
atomic interpreter failure, missing inputs, invalid jumps and bounded loops.
This checks reusable rules across unseen combinations. It cannot validate a
native rule whose semantics have not been implemented.

Further work is scoped to [replay visibility analysis](replay-visibility-goal.md):
camera/body exposure, visual occluders, smokes and observer impairments. The
dependency counts describe research coverage and are not a requirement to
recreate every rendering operation. Rules used for visibility need source
provenance, input/clock bindings, explicit failure output and targeted
validation. Asset discovery can proceed without more replay footage; native
visual accuracy still requires independent validation.
