# Headline rank icons

PNG `largeIcon` assets retrieved from https://valorant-api.com/v1/competitivetiers on 2026-09-04. All are 256px tall; most are 256px wide, while tiers 22 and 25 are 275px wide. The headline display preserves their aspect ratio.

Tier set: `Episode5_CompetitiveTierDataTable` (`03621f52-342b-cf4e-4f86-9350a49c6d04`), which maps Ascendant to tiers 21–23 and Radiant to 27. Filenames correspond to numeric tier IDs. Earlier tier sets use different IDs for Immortal and must not be substituted.

Used for headline rank displays; small badges use the existing embedded icons in `index.html`.

Unranked (`0.png`) was verified against the same tier set on 2026-10-14.
The corresponding official 128px `smallIcon` is embedded in `index.html`.
The app's Unranked aliases (tiers 0–2) all use tier 0's asset. Confirmed
Unranked/placement ranks display the icon and name without RR; unavailable rank
data stays unavailable rather than being converted to an Unranked rank.
