# Clutches page (22 Nov 2026)

Added on request ("use your own imagination on what to add there"). The page
is `/clutches` (also `/player/<name>/<tag>/clutches`), between RR Breakdown and
Match History in the desktop tabs and in the phone **More** sheet.

It uses the same 1vX detection as the Overview's clutch card (`detectClutch`,
`classifyClutchOutcome` and the unresolved-death check in `processMatch`), so
its totals match that card. Win rate on this page is won ÷ situations, as on
the Overview card: a save counts as a situation that was not won.

## Data

- **Per clutch** (`myClutches` on each processed match): the searched player's
  counted clutches, each with round number, situation (1v1–1v5), outcome
  (win, loss, save), kills after the clutch began, side and whether the spike
  was down when the clutch began. It is `null` when the match has no
  round-by-round data and `[]` when it has data but no clutch.
- **Agent** (`myAgent`, `myAgentId` on each processed match): the searched
  player's agent name and UUID.
- **Agent art** (`loadAgentMetadata`/`parseAgentMetadata`, added the same
  day on request): icons and colours from valorant-api.com's playable agents,
  loaded once like the map art and keyed by lower-case name and UUID. Only
  https `media.valorant-api.com` icons and plain hex colours are kept. The
  colour is the first of `backgroundGradientColors`, the dark tint the game
  puts behind each agent. Offline, the tiles show the agent's initial.
- **Side** (`roundAttackers`): a planting round names the attacking team
  directly (the planter's team). Other rounds use the side pattern (one team
  attacks rounds 1–12, the other 13–24, then sides swap every overtime round).
  Which team starts on attack is not assumed: both orientations are tried
  against the match's plants, and the pattern is used only when there is at
  least one plant and every plant agrees with it. Otherwise only planting
  rounds get a side and the rest stay unknown.
- **Spike down**: the plant time is at or before the moment the last teammate
  died. A round with no plant is "before the plant".
- **Aggregation** (`clutchBreakdown`): totals, by situation, by side and spike
  state (four groups), by map, by agent, and the won 1v2-or-harder clutches
  ranked by situation, then kills, then newest. Matches without round data
  are counted separately so the page can say how much it covers.

## Page

- **Clutch stats** (22 Nov 2026, on request): the Overview's clutch card
  (`ClutchCard`) heads the page, without its link to this page and under its
  own heading id (`clutches-clutch-title`), since both pages stay mounted.
  Its description adds clutch kills ("121 clutch kills (1.5 per situation)"),
  the one summary figure shown nowhere else.
- **Removed as duplicates** the same day, on request ("remove what is
  redundant"): the Situations and Won tiles (the card's header and outcome
  bar), the By situation card (the card's 1v1–1v5 tiles; its per-situation
  kills per try went with it) and the Hardest won tile (the first Best
  clutches row). The list below describes the original page.
- Four summary tiles: situations (with the matches covered), won (win rate,
  lost and saved), clutch kills (per situation) and the hardest clutch won.
- **By situation**: 1v1–1v5 rows in the Overview's tile colours, each with a
  won/lost/saved split bar sized by situations on one shared scale, kills per
  try and the win rate.
- **Side and spike**: the same rows for attack and defense, with and without
  the spike down. Situations whose side is unknown are left out and counted
  in a note.
- **Best clutches**: up to 8 won 1v2-or-harder clutches with map, round,
  agent, side, spike state, date, kills and the match score.
- **By map** and **By agent**: sortable tables (situations, won, win rate,
  kills), cards on phones. The agent table shows each agent's icon tile, their
  name in a lightened agent colour (`agentTint`: the tint mixed half with
  white, readable on the dark theme) and a situations bar in that colour.
- **Agent tiles** (`AgentIcon` in `src/app/agent-icon.jsx`): the icon on a
  square in the agent's colour, decorative (the name is always written next
  to it). They appear in the agent table, the best-clutches rows (with the
  agent name tinted) and the hardest-won tile. On phones the best-clutches
  kill badge shortens to "5K" so the map and round fit.
- Empty states: loading, no round data for any match, and no clutch found.

## Limits

- Side is inferred for rounds without a plant. The inference is checked
  against every plant in the match and dropped when any disagrees, but it is
  still an inference for those rounds.
- One act of one player gives a few dozen situations per group, so small
  differences between maps or agents are noise.
- Kills are counted from the moment the clutch began (the last teammate's
  death), the same as `killsAfterClutch`.

## Verification

- `tests/clutches-page.test.mjs`: side inference (either starting team,
  overtime, conflicting plants, no plants), per-clutch records from the demo
  fixture agreeing with the Overview totals, the breakdown's groups and
  ranking, the rendered page, the no-round-data state, and the routing.
- The `demo` and `climb` fixtures now carry round-by-round kills, plants and
  per-player round stats with a few clutch rounds per match (Red attacks
  first; no Sage or Clove, so revive handling stays out of it).
- Agent art: parsing (https host and hex checks, shared entry per name and
  UUID, non-playable agents skipped) and the tile's colour, icon and
  fallback initial are tested. On live data all 17 agent tiles on the page
  loaded their icon, at 800px and 375px with no horizontal scroll.
- Checked in the browser with `?fixture=demo` at 800px, 1280px and 375px (no
  horizontal scroll; phone tables become cards). Checked on live data
  (`npm run dev:live`) for araïse#5055 (V26A6, 172 matches): 484 situations,
  65 won, the same as the Overview card, and every situation got a side
  (every match's plants agreed with one side pattern).
