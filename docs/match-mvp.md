# Match MVP

Added 22 Nov 2026.

## Rule

Riot picks the MVP by Performance Score since Patch 13.06 (22 Sep 2026).
Before that it used ACS, which Performance Score replaced in Competitive,
Unrated, Swiftplay and Premier. Riot's support page says the score
"determines the MVP of the match":
<https://support.riotgames.com/en-us/valorant/gameplay/performance-score>.
Patch summaries report that the two scores picked the same MVP only about
70% of the time at launch, so the old ACS rule mislabelled recent matches.

`pickMvps` in `src/engine/core.mjs`, called from `processMatch`:

- **Performance Score** when every player in the match has a finite
  `performance.score` (0 counts as reported).
- **ACS** otherwise: matches from before Patch 13.06, and matches where only
  some players report a score. Mixing the two scales within one match would
  compare unlike numbers.
- Match MVP is the highest score in the match. Team MVP is the highest score
  on each team, so the Match MVP's team MVP is the same player, and the card
  shows Match MVP for them.
- The basis is stored on the match as `mvpBasis` (`'ps'`, `'acs'` or `null`
  without any scores).
- `scorePlaces` ranks every scored player by the same score (1 = Match MVP),
  ties in list order so first place is always the Match MVP.

Unknown, kept as such: Riot does not publish its tie-break rule or exactly how
Team MVP is assigned. Ties keep the first player listed; the per-team rule is
carried over from the ACS era and is an inference, not documented behaviour.
Archived matches that are later enriched with Performance Scores are
reprocessed, so their MVP moves to the PS rule then.

## Display

The match card marks the MVP on the score that decided it: the PS cell, or the
ACS cell for older matches. The number is gold for Match MVP and silver for
Team MVP, with no icon (a trophy was tried and removed on request); the hint
names the award and the rule ("Match MVP: highest Performance
Score in the match"). After the number, in small muted brackets, comes your
place in the match by that score: "(MVP)" in gold for first, otherwise
"(2nd)" … "(10th)" (`placeText`). The phone card does the same on its PS
figure, and drops ACS from its closed line to make room (older matches show
ACS there instead of PS). This
replaced the trophy and "Match MVP" text beside the result tag, which crowded
the result column. It stays quiet on purpose: louder badges were rejected.

Tests: `tests/match-mvp.test.mjs`.
