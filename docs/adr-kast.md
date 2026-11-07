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
  all 740 rows checked (71 November and 3 October matches) match exactly; on the first 360
  rows, a single rounding to 1 decimal misses 3.
- The raw total misses tracker on 16 of the 100 November rows. Example: Agent X on match
  `0fe28182` was 165.5 from the raw total, is 160.7 now, and tracker shows 160.7.
- Over 199 archived Sxllow matches, the act average went from 139.1 to 138.8.

## KAST

A round counts when the player:

- **K**illed someone (not themself), or
- **A**ssisted, except on a self-kill (an enemy's own spike death lists assisters), or
- **S**urvived: present in the round and alive at its end.
  - A death undone by a revive (Sage, Clove) doesn't count; revives are resolved by
    `computeRealDeaths`, the same positional check the clutch stats use.
  - A spike explosion (kill weapon type `Bomb`) isn't a death. A fall (`Fall`) or a failed
    Clove revive ("Not Dead Yet") is.
  - Presence comes from `presentCount`: the player is in the round's earliest position
    snapshot, or died before it. Riot's `was_afk` is not used; it lags a round.
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
- **AFK:** 2 rows. Yan (Lotus `e707c572`) and Zino (Haven `4422e750`) each had one round
  too many. The fix at this stage used `was_afk`; blind test 3 replaced it with presence,
  which drops a different round for each of them (see there).
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
    Tracker counts the round. The fix at this stage was "a self-kill isn't a death"; blind
    test 3 narrowed it to spike explosions only.

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
matches matched for both ADR and KAST.

### Blind test 3

15 matches from 31 Oct to 5 Nov 2026 (150 rows), read directly from tracker's match pages in
the in-app browser (match IDs from WASHEDMANNY42's and kurd with dream's HenrikDev
history). Seven more matches from 31 Oct returned "Network Error" on tracker (tracker has no
data for them) and were skipped.

- **ADR 150/150.**
- **KAST 146/150.**
  - starboy kipy (`3912425a`), 30% vs 26%: they left the match. Round 23 has no `was_afk`
    flag, but they appear in none of its 7 position snapshots.
  - axl (`4415ea0e`), 79% vs 74%: their only credit in round 10 was an assist on an enemy's
    spike death (the enemy is recorded as killing themself with `Bomb`).
  - anemoia (`925f7b4e`), 42% vs 46%, and adore (`2fb88e2b`), 69% vs 62%: the self-kill rule
    from blind test 1 was too broad. adore's death in round 1 is a self-kill by `Fall`, which
    tracker counts as a death. Only `Bomb` deaths aren't deaths.

Testing each rule on its own across all 330 rows:

| Survived rule | Rows off |
| --- | --- |
| `was_afk` (as before) | 1 |
| `was_afk` or `received_penalty` | 5 |
| `was_afk` or absent from the first snapshot | 5 |
| **absent from the first snapshot only** | **0** |

The AFK flag lags a round. Yan is flagged `was_afk` in round 9 but is in all 7 snapshots,
and isn't flagged in round 10, where they're in none of 8 snapshots and have no loadout.
Zino (rounds 4 and 5) and starboy kipy (rounds 9 and 23) show the same shift. Tracker
counts by presence. The clutch code's `presentCount` already noted that `was_afk` is
unreliable, so KAST now uses it too.

With these changes, all 330 rows of the 33 November matches match for both ADR and KAST,
23 of those matches scored blind first.

### Blind test 4

18 matches from 1 to 6 Nov 2026 (180 rows), new to the fixture, taken from the HenrikDev
history of four players seen in earlier fixture matches (LFT Granit, november, a d a p t,
kasingpa) and read from tracker's match pages in the in-app browser. All seven current maps
appear, including three Corrode matches. The set has 6 spike explosion deaths (3 of them
with assisters) and 10 other self-kills. Each match was scored with the code as committed
in `7d63ab4` before tracker was opened.

- **ADR 180/180.**
- **KAST 180/180.**

No rule changed.

### Blind test 5

20 more matches from 5 to 7 Nov 2026 (200 rows), from the histories of five other players
in blind-test-4 lobbies (Enver, hinami, kurt, andik, kz1x), read the same way and scored
with the same code before tracker was opened. All seven maps appear. The set has 7 spike
explosion deaths (3 with assisters) and 10 other self-kills. Tracker briefly served a
Cloudflare "Just a moment..." check, which cleared on its own; later pages were read with
longer pauses.

- **ADR 200/200.**
- **KAST 200/200.**

One player on `65d0736c` appears as paiNNN 666 in HenrikDev and as mld8nk on tracker (a
name change). They were paired as the only unmatched row on each side, and both values
match.

No rule changed. All 710 rows of the 71 November matches now match, 61 of those matches
scored blind first.

## Older matches

Three matches from 1 Oct 2026 (Sxllow archive) fit a different rule: any victim, 5 s
window (0 of 30 rows off; 3 s leaves 9 off). On the November matches 5 s leaves 36 rows off.
One rule cannot fit both, so tracker most likely changed its method during October and kept
the KAST it had already stored for older matches (an inference). `2fb88e2b`, played
31 Oct 2026 at 21:37 UTC, already fits the current rules, so the change came between 1 and
31 October. The current rules follow the newer matches.

## Tests

`tests/adr-kast.test.mjs` covers each rule and pins all 71 matches
(`tests/fixtures/tracker-adr-kast-2026-11.json.gz`: HenrikDev payloads trimmed to the fields
used, in their original kill order, plus tracker's ADR and KAST per player; blind-test
matches carry `blind: 1` to `5`). Every row must match.
