# ADR and KAST

The overview's **Avg ADR** and **KAST** come from `computeRoundStats` in `index.html`,
which reads the v4 match payload's `rounds[]` and `kills[]` arrays. The starting point was
the ascend-companion scoreboard (`__ascAdv` in `ascend-companion-re/patches/frontend_patches.py`);
the KAST rules were then adjusted until they reproduced tracker.gg.

## ADR

- **Before:** total `stats.damage.dealt` ÷ rounds. HenrikDev passes on Riot's raw total,
  which also counts friendly fire and self-damage.
- **Now:** only damage events whose receiver is on the other team, summed per round
  (`rounds[].stats[].damage_events[]`), ÷ rounds. Without round data (an older or compact
  payload), it falls back to the summary total.
- **Rounding (`trackerFixed1`):** tracker rounds ADR to 2 decimals, then to 1. That
  explains the rows that looked 0.1 off: 135.952 → 135.95 → 135.9 (the double 135.95 sits
  just below the half), 170.955 → 170.95 → 170.9, and 146.545 → 146.55 → 146.6. With it,
  all 210 rows checked (18 November and 3 October matches) match exactly; a single rounding
  to 1 decimal misses 3.
- The raw total misses tracker on 16 of the 100 November rows. Example: Agent X on match
  `0fe28182` was 165.5 from the raw total, is 160.7 now, and tracker shows 160.7.
- Over 199 archived Sxllow matches, the act average went from 139.1 to 138.8.

## KAST

A round counts when the player:

- **K**illed someone (not themself), or
- **A**ssisted, or
- **S**urvived: alive at round end. A death undone by a revive (Sage, Clove) doesn't count;
  revives are resolved by `computeRealDeaths`, the same positional check the clutch stats
  use. A self-inflicted death doesn't count either: Riot records a spike detonation as the
  victim killing themself. A round Riot flags `was_afk` for the player is not survived.
- **T**raded: their killer died to one of their teammates after their death, no more than
  3 s later, and they were the killer's last victim before that trade kill. A trade credits
  only the last teammate the killer took. Kills in the same millisecond: a victim listed later
  in HenrikDev's kill list counts as later, a victim killed in the trade kill's own
  millisecond doesn't come "before" it, and a trade in the death's own millisecond doesn't
  count.

KAST = counted rounds ÷ rounds in the match, as a percentage where exactly .5 rounds to
even (`roundHalfEven`: 15/24 = 62.5% → 62, as tracker shows). The overview weights by
rounds across matches and says on hover how many matches had round data.

## How the rules were found

Ten November matches (3 to 6 Nov 2026, 100 player rows) from tracker screenshots, compared
with the HenrikDev payload of each match. Rows that differ from tracker as each rule is added:

| Rules | Rows off |
| --- | --- |
| Ascend: kill, assist, never killed, any trade within 3 s | 11 |
| + trade credits only the killer's most recent victim | 4 |
| + AFK rounds aren't survived | 2 |
| + revived and alive at round end is survived | 1 |
| + trade kill must come strictly after the death | **0** |

Each added rule fixed its rows without breaking another. The evidence for each:

- **Most recent victim:** 7 rows. Example: Summit (`d0df12e1`) round 20. inbinds agnite kills
  Acrocanthosaurus at 17.85 s and Akuma at 19.23 s, and dies to tu tait at 20.72 s; tracker
  credits only Akuma. Timing alone can't explain it: tracker counts hatehatehatehate's
  2.978 s trade (Haven, round 1) but not this 2.875 s one, and no cut-off in milliseconds or
  whole seconds fits both. A tracker screenshot of round 20 shows the same kill feed as
  HenrikDev.
- **AFK:** 2 rows. Yan (Lotus `e707c572`, round 9) and Zino (Haven `4422e750`, round 4) only
  "survived" those rounds, and `was_afk` is true for both.
- **Revive:** 1 row. bissyboy4511 (Sunset `c0790deb`, round 8) was killed at 2.5 s, then
  appears alive in kill snapshots at 24.4, 29.0 and 30.7 s; their team had a Sage.
- **Strictly after:** 1 row. WASHEDMANNY42 (Sunset `977db87f`, round 15) was killed by yuno,
  and Jobless killed yuno in the same millisecond (11.833 s).

Three of these rules rest on one or two rows each. They are inferences from matching
tracker's numbers, not read from tracker's code.

## Blind tests

Each set of four matches was scored with the code as it stood before looking at the
matches; the misses then led to the fixes described.

### Blind test 1

Four matches from 6 Nov 2026 (`fa0d31ff`, `11962da8`, `560e631e`, `1c56b889`; 40 rows):

- **ADR 39/40.** BayHarborButcher 136.0 vs tracker 135.9 (135.952): this led to the
  two-decimal rounding above, which also explains the two earlier 0.1 misses.
- **KAST 38/40.**
  - JuliONline 63% vs 62%: exactly 15/24 = 62.5%, so tracker rounds half to even (or down;
    one row can't tell those apart).
  - Ria 62% vs 65%: in Summit round 14 the spike detonated on her, recorded as a self-kill.
    Tracker counts the round, so a self-inflicted death isn't a KAST death. The 14 matches
    hold 5 self-kill deaths and no team kills, so "only an enemy kill is a death" fits
    equally; the narrower rule is implemented.

After those three fixes, all 140 November rows matched for both ADR and KAST, and the
October ADR rows still matched.

### Blind test 2

Four matches from 5 and 6 Nov 2026 (`cdcacc5a`, `b18f7e9e`, `6e2a5fec`, `ee3c15cf`; 40 rows):

- **ADR 40/40.**
- **KAST 38/40.** Both misses involve kills in the same millisecond:
  - LuhBirdo (Summit `cdcacc5a`, round 13), 81% vs 75%: wrath killed LuhBirdo and then
    erenmitB, both at 10.383 s, and was traded at 12.061 s. Tracker gives the trade to
    erenmitB, the later entry in the kill list; the old rule ignored same-millisecond
    victims and credited both.
  - aaapowerline (Sunset `6e2a5fec`, round 8), 50% vs 56%: 1ce killed aaapowerline at
    20.990 s, then killed Doyle at 23.851 s, the same millisecond 1ce died. Tracker credits
    aaapowerline; the old rule counted Doyle's death as "killed again" and dropped it.

The fix: the trade goes to the killer's last victim strictly before the trade kill, in
kill-list order. It also covers the earlier "strictly after the death" case (no victim comes
before a trade in the death's own millisecond). With it, all 180 rows of the 18 November
matches match for both ADR and KAST.

## Older matches

Three matches from 1 Oct 2026 (Sxllow archive) fit a different rule: any victim, 5 s
window (0 of 30 rows off; 3 s leaves 9 off). On the November matches 5 s leaves 36 rows off.
One rule cannot fit both, so tracker most likely changed its method during October and kept
the KAST it had already stored for older matches (an inference). The current rules follow
the November matches.

## Tests

`tests/adr-kast.test.mjs` covers each rule and pins all eighteen November matches
(`tests/fixtures/tracker-adr-kast-2026-11.json.gz`: HenrikDev payloads trimmed to the fields
used, in their original kill order, plus tracker's ADR and KAST per player; blind-test
matches carry `blind: 1` or `blind: 2`). Every row must match.
