#!/usr/bin/env bash
# Run the parse sandbox's parser call (without the container) over local
# replays and check every record with the site's validator. Local evidence for
# docs/replay-parser.md; parse only replays you recorded yourself.
#
# Usage: scripts/replay-parser-corpus.sh <vrfkit binary> <out dir> <replay.vrf>...
set -uo pipefail
bin=$1 out=$2; shift 2
mkdir -p "$out"
here=$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })
printf 'match\tbuild\tvalidate\texport\tseconds\tsource\tcompact\n'
for f in "$@"; do
  id=$(basename "$f" .vrf)
  dir="$out/$id"; rm -rf "$dir"; mkdir -p "$dir"
  bytes=$(stat -c %s "$f"); sha=$(sha256sum "$f" | cut -c1-64)
  "$bin" validate "$f" >/dev/null 2>&1; v=$?
  start=$(date +%s%N)
  "$bin" export "$f" --out "$dir/export" --checkpoints --require-pass --solve-unknown \
    --compact "$dir/compact.json" --match-id "$id" --source-bytes "$bytes" --source-sha256 "$sha" \
    --decoder-revision b9496df61c40fa304d4f539689c1dd627804946e --decoder-patch "$(printf '0%.0s' {1..64})" \
    >"$dir/export.out" 2>"$dir/export.err"; e=$?
  ms=$(( ($(date +%s%N) - start) / 1000000 ))
  check=$(node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { validateCompact } from 'file:///$here/lib/replay-compact.mjs';
    try {
      const doc = validateCompact(JSON.parse(readFileSync(process.argv[1], 'utf8')), { matchId: process.argv[2] });
      console.log(doc.decoder.transform.source + '\t' + 'ok ' + doc.events.rounds.length + ' rounds ' + doc.events.kills.length + ' kills');
    } catch (err) { console.log('-\t' + (err.message || err)); }" "$dir/compact.json" "$id" 2>/dev/null)
  build=$(grep -ao 'release-[0-9.]*' "$f" | head -1)
  printf '%s\t%s\t%s\t%s\t%d.%d\t%s\n' "${id:0:8}" "${build#release-}" "$v" "$e" $((ms / 1000)) $((ms % 1000 / 100)) "$check"
done
