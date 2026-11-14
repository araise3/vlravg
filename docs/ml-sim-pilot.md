# ML simulation pilot (research for ascend-companion-re)

Not part of the site. ascend-companion-re's lobby win predictor learns from the user's own
games (about 20 so far). The pilot tests whether archived matches can be turned into training
games by rebuilding every player's tracker-style current-act stats as they stood when the match
started, from the player's own earlier games.

- **Matches:** 2,000 competitive matches of act e11a6 (13 Oct to 12 Nov 2026) from
  `match_archive`, spread evenly over the act.
- **Players:** their 13,568 players, listed in D1 `sim_pilot_players` (puuid, region).
- **Histories:** `.github/workflows/sim-pilot-fetch.yml` fetches each player's e11a6 history
  through the site's own `/api/stored-matches/{region}/{puuid}?page=N` route: the public key
  behind the same atomic quota gate as live visitors, paced to 40 requests a minute (the key
  allows 60), up to 4 pages of 100. Each player row gets the HTTP status, the match count and a
  gzip+base64 list of compact matches (agent, team, K/D/A, score, damage, shots, rounds, tier;
  no names or tags). Runs log only counts, since the repository's Action logs are public.
- **Unattended runs:** the first night's second run died on one `ECONNRESET` from the D1 API,
  and GitHub dropped the hourly triggers for six hours. Now every D1 call and page request
  retries network errors, 5xx and 429; a player is saved only when every page came back (one
  had been stored with page 1 only), otherwise the row stays open and counts an attempt, closed
  with status 0 after 3; the script never throws. Each run starts the next one itself while
  players remain and it made progress (GitHub's job limit is 6 h); the hourly schedule is the
  backup. Two workers share one 40/min pacer; the site's quota gate (live visitors, the RR
  collector borrowing public slots) holds it nearer 20–25/min. `tests/sim-pilot-fetch.test.mjs`
  covers resets, 429s, failed pages, a dead D1 and the run budget.
- **KAST and ADR:** taken from `computeRoundStats` (docs/adr-kast.md) for matches in the
  archive, with tracker's older trade rule for matches before 27 Oct 2026 17:00 UTC, since
  tracker's act totals add up its stored per-match values. On 4 archive matches from September
  and October that gave 40 of 40 KAST rows equal to tracker's match pages.

The simulation and training run locally in ascend-companion-re. Once the pilot is evaluated,
delete the workflow and, if not needed, the `sim_pilot_players` table.
