# Estimated visual response from replays

The offline metric follows the parser → geometry/visibility model → encounter
state machine architecture described in
[the CS2 research](cs2-reaction-architecture-research.md). It measures **modeled
visual contact to the first observed gun discharge**, whether it hits or misses.
It is not isolated human reaction time, time to damage, or time to kill.

Run the corpus build with the existing replay Python environment and Node:

```powershell
.venv-replay/Scripts/python.exe scripts/run-estimated-replay-batch.py `
  .local/replay-transcripts/corpus/corpus.json `
  .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review --jobs 3
```

The output is `review/estimated-metrics/index.html` and `index.json`, with a
JSON audit and browsable page for each match in `matches/`. Player UUIDs are
aggregated across matches; means weight encounters equally. The pooled
all-player average must not be described as the searched user's reaction time.
Clicking a player's match link selects that observer in the match report.
The match headline statistics pool that match's players; the selected observer's
statistics appear immediately below the observer control.

The corpus driver uses the strict single-match builder concurrently:

```powershell
.venv-replay/Scripts/python.exe scripts/run-estimated-replay-batch.py `
  .local/replay-transcripts/corpus/corpus.json `
  .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review --jobs 1
```

It schedules one job per match and publishes the corpus index from one thread.
Do not run two batches into the same output directory. Source receipts and
metric policy are identical to the sequential builder.
The driver excludes rounds with missing or invalid observed combat intervals,
such as an unfinished final round. Their timing stays unknown, while the
replay's clocked rounds can still contribute estimates. This additional
selection has its own implementation hash in the affected result receipt and
is disclosed in the match page and corpus index. A match without any usable
combat interval retains null timing statistics; other matches continue.
Unexpected errors are reported immediately and leave the corpus incomplete.

The build uses the existing decoded shot RPCs, not kills, damage events or ammo
drops to invent gun discharges. It verifies the published replay bundle,
export-manifest identity, camera/possession sidecar and visibility inputs. It
pins movement, geometry, model inputs, decoder revision and implementation
hashes. Known parser framing errors or ambiguous firing extraction block the
affected match. Unresolved RPCs are still a semantic-completeness limitation;
an estimate uses the available observed discharges.

Every combat period is sampled on a 50 ms grid with additional shot, life,
vision-effect and dependency boundaries. Original movement is selected with
an ASOF join: the retained pose timestamp is at or before the query time, and
the evaluator rejects a pose older than 50 ms. It does not interpolate from
future updates or substitute the playback-downsampled tracks.

The estimated model uses active-weapon world FOV, the existing asset stance
and eye-offset model, incomplete static opaque geometry and the verified
additive overlays when available. It samples three heights at the target
origin and at lateral offsets of ±21 cm, perpendicular to the sightline.
The lateral width is a disclosed modeling choice, **not recovered anatomy**.
All view, wall and effect tests must agree for the same point. Nine points
can miss a small exposed body part or sample empty space; they do not recover
native bones, animation, a weapon silhouette or actual screen pixels.

Flash/nearsight, remote possession, intersecting smoke uncertainties and
unresolved dynamic/ability barriers use the existing conservative exclusions.
Radar flags, relevance, spectator outlines and reveal-override membership do
not become direct visibility. Native visibility always remains separate from
the modeled contact states.

An encounter begins only after at least 250 ms of continuously usable,
all-enemies-hidden history. The first qualifying discharge finishes it; one
shot does not produce separate response measurements for multiple targets.
The endpoint is a firearm action while an onset target remains modeled visible.
The shot's intended target and causal relationship to that contact are unverified.
The calculation excludes preceding fire within 300 ms, short re-peeks,
unbracketed onset, unknown visibility, stale poses, gaps, loss of all onset
targets, mismatched/unusable shots, and responses longer than two seconds.
Death, round/life changes and the end of coverage also terminate a pending
encounter. No-response and excluded encounters remain in the audit. These
cutoffs are analysis policy, not biological or engine constants.

For last hidden time `h`, first modeled visible time `v`, and discharge `s`:

```text
reported response = s - v
sampling interval = [s - v, s - h]
```

Those bounds cover sample spacing only. Model, network, display and input
timing error remain unbounded. A near-zero estimate can reflect anticipation,
model error or sampling; it must not be presented as an instantaneous human
reaction. Means and medians use the accepted, responded population, with
coverage and exclusion counts shown beside them. Empty populations are null.

For sensitivity comparisons, build into a different directory:

```powershell
.venv-replay/Scripts/python.exe scripts/build-estimated-replay-metrics.py `
  .local/replay-transcripts/corpus/corpus.json `
  .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review `
  --match <match-id> --body-half-width-cm 0 --out .local/response-centerline
```

Zero lateral width selects the original three centerline points. `--round 0`
restricts an explicitly selected match to its first round for development.
Default builds process every validated replay. Cached results are reused only
when receipts and policy match; partial output reports its processed count.

A sensitivity check on round 1 of Abyss replay `026ccda1` used identical
evidence and implementation receipts:

| Body sampling | Eligible responses | Mean | Median |
| --- | ---: | ---: | ---: |
| Three centerline points | 9 | 370.6 ms | 350 ms |
| Nine points, ±21 cm | 10 | 315.4 ms | 323 ms |

Eight discharges appear in both accepted populations; one appears only with
centerline sampling and two only with the wider grid. For the eight shared
samples, the wider grid increased the mean contact-to-shot duration by 33 ms.
This is a sensitivity example from one round, not evidence that either model
is accurate. The full-match and selected-round runs produced identical
first-round audit records. Hashed comparison receipts are in the local
`estimated-metrics/model-sensitivity.json` artifact.

The batch evaluator skips entirely off-screen model silhouettes and irrelevant
effect-ray work. Its optional boolean occlusion traversal stops on any wall
hit; ordinary viewer rays still find the nearest hit. Default viewer body
sampling stays at three centerline points. Repeating the same native validation
flags as false does not prevent calculating a separately labeled estimate.

Validation commands:

```powershell
node --test --test-isolation=none tests/replay-estimated-response.test.cjs `
  tests/replay-visibility-runtime.test.cjs tests/replay-visibility-effects.test.cjs `
  tests/replay-transcription-viewer.test.cjs
.venv-replay/Scripts/python.exe scripts/test-estimated-replay-metrics.py
.venv-replay/Scripts/python.exe scripts/audit-estimated-replay-metrics.py `
  .local/replay-transcripts/corpus/corpus.json `
  .local/replay-transcripts/8dac718f-24f5-4042-99a7-4a2a27f2d22f/review
```

These cover encounter censoring, multi-target handling, near-zero sampling
bounds, missing shot frames, short impairment boundaries, deaths/revivals,
partial-body exposure, occlusion-query equivalence and causal movement
selection. They also cover an unfinished round alongside a clocked round and
a replay with no observed combat clock. They verify the calculation and input handling, not native visual
accuracy. All native camera/body/opacity/activation verification flags remain
false; uncertain native LOS remains unknown. No live client, game modification,
account access or external upload is part of this pipeline.

The independent audit checks source files and implementation hashes, every
accepted discharge against the published event inventory, first-shot selection,
prefire exclusion, causal onset poses, sampling bounds, per-player aggregation
and all native-verification flags. It writes a hashed `audit.json` receipt.
`--allow-partial` audits a snapshot during an active build; a full audit requires
all validated corpus replays. Refreshing the replay-library index adds report
links for the metric pages that exist.

The completed local 33-replay corpus contains 3,750 eligible estimated responses.
All 33 results passed the independent source and arithmetic audit. Round 14 of
Lotus replay `af18d8c5` lacks an observed combat interval and stays excluded with
unknown timing; its 13 clocked rounds contribute 103 eligible responses.
Validation includes 62 JavaScript checks and five Python checks. These results
validate the offline pipeline and its exclusions, while native perception stays
unverified. The refreshed replay presentations preserve the exact decoded
evidence and verified visibility inputs.
