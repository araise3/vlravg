# Replay visibility analysis goal

The user's stated goal is a tool like the original reference video: load a
Valorant replay and accurately determine when an observer could see an enemy,
respecting walls, smokes, flashes and other visibility restrictions.

## Completion criteria

- Load replays through the local library, with explicit build support checks.
- Produce a directed observer-to-target visibility timeline: A seeing B does
  not imply B seeing A.
- Report acquisition and loss intervals on the replay clock, with sampling
  bounds and a reason for each transition.
- Evaluate actual view direction/FOV and camera position, partial target-body
  exposure, static walls and runtime barriers, ability-specific smoke behavior,
  blindness/nearsight, and relevant target visibility restrictions.
- Distinguish direct sight from observer/team-specific in-world reveals.
- Display and export the timeline through the replay analysis UI.
- Return unknown with an explicit dependency when required evidence is absent;
  never substitute network relevancy or spectator outlines for player vision.
- Validate supported cases against synchronized first-person replay playback
  with spectator x-ray disabled, and report measured timing error and coverage.

"Any replay" is the desired loading experience, not an assertion that every
historical build is already supported. Replay and asset version mismatches
must be detectable. Asset availability alone does not establish that every
native runtime rule or necessary observer state has been recovered.

## Implementation priorities

1. Audit the existing visibility input and scene contracts against the current
   replay corpus; inventory the missing inputs by map, build and ability.
2. Establish camera/FOV and target-body evidence, including crouch and partial
   cover. Actor-center rays alone are insufficient.
3. Complete versioned visual occluder geometry and dynamic barrier bindings;
   account for transforms, level activation and visual material behavior.
4. Bind smoke lifecycle/shape rules and observer impairments to the replay
   clock, retaining unknown outcomes for unresolved visual transitions.
5. Integrate the evaluator into replay playback and export contact intervals
   with evidence and timing bounds.
6. Validate ordinary peeks first, then scopes, partial cover, smoke boundaries,
   overlapping effects, flashes, nearsight and reveals. Expand supported
   profiles only with evidence.

The existing animation and behavior asset libraries are supporting research.
Their extraction and synthetic checks do not establish replay visibility
accuracy. Further animation work should serve camera or exposed-body accuracy;
general visual reproduction is not the completion target.

Partial flash fade is not inherently a binary visibility state. Preserve the
impairment evidence and document any later perceptibility policy separately
from geometric line of sight.

## Current visibility milestone

The local replay viewer now evaluates each of its three modeled body points
through view, wall and smoke checks together. It no longer combines one point's
on-screen projection with a different point's clear ray. Smoke crossings and
inside-effect checks are evaluated per body point rather than only at the
actor center. These remain capsule-centerline approximations.

The selected observer-target pair has contact intervals, acquisition/loss
sample brackets, an inspectable current-ray report and a visibility JSON export.
Samples include a 50 ms grid plus observed smoke, vision-effect and life-state
boundaries. Unknown states, long gaps and round/life changes break contacts.
An already-visible stream start does not establish acquisition. Turning off
the illustrative flash overlay does not disable effect checks.

The viewer reports model contacts separately from player-visibility evidence.
Current live-player visibility remains unknown because actual camera/anatomy,
complete visual geometry, effect coverage and asset/replay version parity are
unvalidated. The displayed timing brackets cover evaluator samples only; they
do not bound render clock or sampled-pose error. This milestone is the
integration and diagnostic foundation, not validation of ordinary-peek timing.

The offline analyzer uses the same pair evaluator with original movement
samples. It binds the review to the exact export manifest, hashes the movement
Parquet and published BVH, and records evaluator/decoder provenance. Select a
pair by replay slot or subject UUID:

```powershell
.venv-replay/Scripts/python.exe scripts/build-replay-visibility.py `
  .local/replay-transcripts/corpus/corpus.json `
  .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review `
  --match 8dac718f-24f5-4042-99a7-4a2a27f2d22f --observer P3 --target P2 `
  --start-ms 61771 --end-ms 66271 `
  --out .local/replay-transcripts/visibility/abyss-p3-p2.json
```

In the exercised Abyss clip, the native-sample model contact bracket is
63858–63866 ms. The coarse viewer bracket is 63871–63921 ms. Neither establishes
actual rendered contact; this comparison demonstrates timing error introduced
by using the overview samples. The 200077–201398 ms Yoru flash example also
retains exact effect boundaries and keeps every active-effect model sample
unknown. The checks include original replay integration cases and
cross-language static-ray and moving-object comparisons. They
verify the implementation and source identities; they do not validate game
fidelity.

The local service now connects this analyzer to all 33 published viewers.
Moment clips analyze original timestamps automatically; full rounds use an
explicit control. Results retain both players' native movement samples for
the displayed clip, source hashes, body rays and separate model/evidence
intervals. A full-round service check analyzed 12,415 samples. Pair/window
changes discard stale UI responses, and cache keys include evidence and code.

The impairment assessor also reads typed blind arrays and scalars by separate
actor/component identity, continuous-effect inheritance and conditional
asset-proven fade windows. It found 38 Gekko Dizzy recipient effects omitted
from the earlier profile-only guard. Eighteen conditional fade rules come from
28 checked installed packages; nine unsupported implementations remain explicit
gaps. A StopEffect RPC cannot establish immediate shader clearance. In the
Yoru example, the observed 201398 ms stop now retains an unverified asset fade
window through 202398 ms. The native opacity endpoint is still unknown.

Thirty-three source-pinned camera/body sidecars retain 2,120 independent
possession intervals, including 70 round knowledge caps. A matching observer
interval makes body-camera model contacts unknown. Neither the possession flag
nor the actor's class name establishes the native camera transform. In replay
1163ee28, camera actor 3872 is observed possessed from 43360 to 53657 ms.

Lotus uses a separately verified static overlay for the previously omitted
always-loaded Jam_ArtDefPathCExterior level. It adds 94,461 opaque triangles.
Each body ray chooses the nearest hit across original and overlay BVHs;
original map/export bytes remain unchanged. Three missing obstruction rays
(crate, pillar, exterior wall) agree exactly between Python and browser math.
Native achieved door poses, masked materials and omitted components remain gaps.

Separately verified Brimstone and Clove smoke profiles add 1,517 observed actors
across all 33 replays (108 Brimstone, 1,409 Clove). Installed assets supply the
actual hollow boundary meshes, attachment scales, expansion/collapse curves
and a 410 cm inside-volume radius. There are no matching intro-loop RPCs in
this corpus: all added activation clocks therefore use the explicitly
conditional channel-open-plus-delay model. Neither a channel opening nor its
closing establishes native visual activation/extinction. Brimstone's 238
observed recipient-nearsight intervals remain independent of smoke ownership.
The viewer identifies these timing assumptions, and original replay/model
bytes are unchanged.

Ability sidecars preserve 37 Viper wall activation windows and nine Vyse wall
initializations/enables. Viper's world anchor inputs and Vyse's exact RPC
endpoints are evidence, but native procedural geometry, achieved scale and
shader envelopes are unresolved. These potential walls interrupt otherwise
visible model contacts rather than inventing an opaque mesh or a clear ray.
Their windows end at the round knowledge cap; deactivation, conditional
asset tails and channel close do not prove visual extinction. Current-time
reports exclude later anchors, collision-enable, stop and close observations.
Placement-only traps do not activate walls.

Six Ascent/Lotus replays also attach 22 exact installed map-object identities,
with 851 strictly decoded observations. Source-derived bounds cover Lotus's
full door sweep, including its explicit BeginPlay mesh relocation, and
Ascent's finite horizontal lift columns with unbounded vertical extent.
Intersecting a region with unresolved achieved geometry makes that body ray
unknown. A separate clear body ray can still establish a model contact.
Only a current-round, current-channel-epoch decoded `bHidden=true` omits that
actor body in the display model. Desired door state, destruction flags,
earlier-round state and channel close cannot silently clear geometry.
Python and browser runtime use the same scoped dependency rules.

Added inputs bind exact published replay, export/Parquet, helper, mapping and
installed archive identities. The local service includes these sources and
their presence in its cache key and rejects an in-flight result if its
sources change. All of these checks validate reconstruction and provenance;
native rendered visibility and contact timing are still unvalidated.

The current checks cover 59 Node tests, 85 Python tests and ten real replay
clips (1,298 native samples). Static-ray comparisons cover 12 checks;
moving-object comparisons cover 8,828 dependency cases, plus round/bounds
rejection and geometry checks. All 33 refreshed viewers passed the full
replay, addon and animation provenance audit. These remain reconstruction
tests, not native visual-fidelity validation.
The integrated Ascent browser check analyzed 8,342 original samples for a
full round with the new wall inputs. At 140357 ms its current-ray inspector
uses both players' 140357 ms poses, retains the observed Vyse initialization
and excludes the later collision-enable event.

The integration artifacts are under `review/visibility-native-verified-examples-v3`;
the refreshed 33-replay audit is `review/behavior-coverage/final-audit.json`.
See [replay-static-art-overlay.md](replay-static-art-overlay.md) for the overlay
provenance and [serve-replay-library.py](../scripts/serve-replay-library.py) for
the local service.

Repeat the real-clip checks with:

```powershell
.venv-replay/Scripts/python.exe scripts/verify-native-visibility.py `
  .local/replay-transcripts/corpus/corpus.json `
  .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review `
  --out .local/replay-transcripts/visibility-current-check
```

`check-replay-dynamic-occluders.py` produces an immutable Python/browser proof
from the current corpus, review, dynamic assets and sidecars; choose a new
output directory for each run. Its paired `.cjs` checker verifies every
expected result against the same visibility runtime used by the viewer.

See [reaction-time.md](reaction-time.md) for the current visibility contract
and experimental geometry engine, and
[replay-behavior-engine.md](replay-behavior-engine.md) for asset reconstruction
and its limits.

The asset-first camera/body, compiled shader and activation pass is documented
in [replay-native-visibility-assets.md](replay-native-visibility-assets.md).
It resolves observed player-class bindings across all 33 replays, extracts 60
rest/skinning meshes and 140 compiled shader records, and adds causal pose and
smoke-timing disclosures. Native LOS remains unfinished; uncertain visibility
remains unknown.

The continuation preserves 59 referenced animation graphs with 1,374 nodes
and 143 exposed member writes, disassembles every recovered SM6 program
(62 unique programs), and proves four smoke timer requests plus virtual
dispatch sources for six modeled smoke classes. Its reproducibility audit
and eleven real-asset regression tests pass. The camera asset exposes a native
parent and no Blueprint camera functions. Native node mapping, camera/body
transforms, achieved shader inputs/compositing and engine-clock bindings
remain unresolved; no native visibility flag was promoted.

The next asset pass recovers the sparse class-default-object layer for those
graphs: 620 property-copy routes, generated constant/mutable layouts and
1,374 exposed-value handlers. Native velocity/state fields, copy precision
and exact handler operands are retained without assigning native node order.
It also follows 175 effect/render packages containing 45 particle systems,
517 emitters, 605 LOD records and 308 dynamic-parameter module occurrences.
Emitter delays and distribution clocks remain serialized inputs, with null
achieved activation times and particle ages.

Both first-person and broadcast HUD templates bind the blind overlay to
`1P_HUD_FlashBackground_MI`. The checked widget path creates the dynamic
material and supplies it to the image and scalar writes. Its parent's
compiled alpha correspondence includes `Alpha_ColorMult * GlobalAlpha`;
the fade scalar alone cannot establish native opacity. The expanded shader
evidence covers 262 materials and 2,566 unique SM6 programs. Eight added
render-binding tests cover object identity, particle clocks, widget routing
and the additional opacity operand. Runtime HUD/LOD/permutation selection,
camera/body poses, achieved uniforms/compositing and engine-clock alignment
remain unverified. Uncertain visibility stays unknown.
