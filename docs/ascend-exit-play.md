# Ascend preview research and exit-play detection

## What the supplied installer contains

Inspected `Ascend-Companion-Setup.exe` version 0.2.15 (SHA-256 `DEE60692CE34D304F11422C107FA926BD1CEDE49BB87F5EA6BF5B1EC4C376A4B`). It is a signed NSIS archive. The app executable was extracted without installing or running it. It is a Tauri 2 desktop app with Brotli-compressed web assets. `scripts/inspect-tauri-assets.py` can extract selected assets for local inspection; do not commit Ascend's extracted JavaScript or artwork into this repository.

The replay web bundle shows a React UI driven by a structured replay payload. It uses round-scoped player tracks with time, x, y, facing angle and sometimes z, plus kills, health, weapons, credits, spike state, utility, shots and paths. Playback can decimate the recorded tracks according to the chosen rate. It draws the map and dynamic layers with canvases, loads map outlines as SVG, and offers a vision layer backed by geometry and a WebAssembly helper. The app has bundled demo payloads and a `replay_payload` native command for user replays. The supplied executable does not reveal the server-side processing implementation or establish which VRF parser Ascend uses.

The public [Ascend preview](https://www.play-ascend.com/download) exposes the product behavior: round selection, playback speed, scrubbing, all ten player panels, and utility, path, shot and vision toggles. Those controls are useful reference points for our viewer, but the distinctive opportunity for vlravg is evidence-based decision review, not a copy of their interface.

## What “playing for exits” means here

A player chooses a kill or save route over a still plausible attempt to win the round. A late kill alone is **not** evidence: the player may be clearing toward a defuse, holding a legitimate postplant angle, trading, or already have no viable path to the objective. Replay data can support a *review candidate*, not a claim about the player's intent.

Start with **defender postplant** situations, where the planted spike has a known position and a clear deadline. A useful candidate needs all of these observations:

1. The player is alive while the spike is planted, and the round ultimately detonates.
2. At a chosen decision point, a win attempt is still physically plausible given remaining time, the player's position, living opponents and map route. A straight-line distance is insufficient on Abyss.
3. Over a sustained interval, the player's route increases navigable distance or travel time to the spike, and there is no defuse attempt or return toward it.
4. The player takes fights along an exit or save route while the objective remains uncontested by that player.

Report the relevant timestamps, route, spike location, living player count and kills. Label it **possible exit play** and let the viewer inspect the interval. Distinguish a reasonable save after the round became unwinnable; that is not an abandoned clutch. Later, consider attacker rounds where the spike carrier forgoes a feasible plant, but those have more ambiguous objectives.

## Checks against the supplied Abyss replay

The `vrfkit` export includes 19 typed `BombPlantedRPC.PlantLocation` values, so spike positions are available beyond the event timestamps used by the current viewer. It also contains `BombDefuseStartRPC`, `BombDefuseStopRPC` and checkpoint fields. Those can establish whether a player actually started a defuse. Ascend's bundle demonstrates the value of including this richer objective state in a compact per-round payload.

- Round 2 ended by detonation. Blue P3 killed two Red attackers about 5 and 3 seconds before the explosion, which would look like exit kills under a simple time rule. Their straight-line distance to the planted spike **fell** from about 0.20 to 0.04 of the normalized map during the preceding 20 seconds. This is a strong counterexample to a late-kill-only detector: P3 was moving toward the objective.
- Round 18 also ended by detonation. Red P9's distance **rose** from about 0.12 to 0.27 over the last 20 seconds and P9 killed a Blue attacker about 1.5 seconds before the explosion. A defender started and then stopped a defuse about 6 seconds before the explosion, while Red teammate P7 was near the spike. This is not a clean solo clutch abandonment. It is worth reviewing on the map rather than automatically scoring.

The local viewer now shows the planted spike, defuse start/stop events, and a manual “watch this decision” window. The first conservative rule flagged round 18 P9 and rejected round 2 P3. It requires a losing-side kill within seven seconds of detonation plus a material increase in straight-line distance to the spike during the preceding interval.

This remains a prototype. It samples movement every 500 ms and does not yet model life state, navigable routes, site entrances, weapon value, or whether enough time remained to clear opponents and defuse. The raw Parquet export retains the higher-rate movement and objective fields. Before displaying this in the public site, replace normalized straight-line distance with an Abyss navigation graph and validate on several known positive and negative clips, including saves, lost retakes, and late kills while moving toward the spike.
