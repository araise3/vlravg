# Search typing speed

25 Nov 2026. With a full match history loaded (169 match cards shown after
"Load More"), each keystroke in the search bar lagged visibly.

## Cause

`setSearchText` called `emit()` on every keystroke, and `searchText` was part of
the engine snapshot. Each key therefore produced a new snapshot, and every
`useEngine()` component re-rendered: the active page in full, including every
match card (`MatchLogCard` is memoized, but it receives the snapshot `s`, which
was new each time). `onManualInput` also called `showSeasonIdle()` (another
emit) on every keystroke while the text was not a valid Riot ID.

## Fix

- The search text is its own small store in `src/engine/core.mjs`
  (`subscribeSearch`, `getSearchText`), read through `useSearchText()` in
  `src/app/hooks.js`. It is no longer in the snapshot.
- `setSearchText` notifies only the search listeners. It emits a snapshot only
  when `onManualInput` changed visible state: hiding the Tracker.gg pill, or
  resetting the act picker. That happens once when you start editing a loaded
  name, not on every key.
- Code that sets `searchText` and then calls `emit()` (route loads, pro picks,
  account resolution) still updates the field, because `emit()` also notifies
  the search listeners.

## Measurement

Dev build (`npm run dev`, `?fixture=169`, all cards shown, Match History open).
Time from the input event until a zero-delay timeout runs, 10 keystrokes:

| | median | max |
|---|---|---|
| before | 443 ms | 496 ms |
| after | 7–12 ms | 17.5 ms |

Not measured: a production build, or the first keystroke after a real search
loaded. That first key still emits once (it hides the Tracker.gg pill and resets
the act picker), so it costs one full re-render.

Test: `tests/search-typing.test.mjs`.
