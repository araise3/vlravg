#!/usr/bin/env bash
# Parser job 2 of 3. Runs with no secrets and permissions: {}. Each uploaded
# replay is hostile input, so the parser (parser/: one `vrfkit export` call
# that solves an unknown build's transform first, then validates, exports and
# writes the compact document in one pass) runs in a throwaway container: no network, read-only root and inputs, no writable bind
# mount, all capabilities dropped, no privilege escalation, an unprivileged
# user, and memory/PID/CPU/time limits. The only way out is stdout: a tar of
# compact.json and the full `vrfkit export --checkpoints` tables, capped at
# 640 MiB and unpacked through an exact allowlist (replay-unpack.py).
# Failures map to fixed exit codes. The submit job still treats the output as
# untrusted.
#
# Usage: replay-parse-sandbox.sh <work dir> <toolchain dir> <image>
set -uo pipefail
work=$(realpath "$1") tool=$(realpath "$2") image=$3
cap=$((640 * 1024 * 1024))
mkdir -p "$work/parsed"
chmod 0555 "$tool/vrfkit"

jq -c '.[]' "$work/replays/jobs.json" | while read -r job; do
  id=$(jq -r .match_id <<<"$job"); bytes=$(jq -r .bytes <<<"$job"); sha=$(jq -r .sha256 <<<"$job")
  [[ $id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ && $bytes =~ ^[0-9]+$ && $sha =~ ^[0-9a-f]{64}$ ]] || continue
  out="$work/parsed/$id"
  mkdir -p "$out"
  # 30 minutes: solving an unknown build's transform takes minutes on 2 CPUs.
  timeout --kill-after=15 1800 docker run --rm --name "parse-$id" --init \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user 65534:65534 --memory 6g --memory-swap 6g --pids-limit 256 --cpus 2 --ulimit nofile=1024:1024 \
    --tmpfs /work:rw,size=3g,mode=1777 --tmpfs /tmp:rw,size=64m,mode=1777 \
    -v "$work/replays/$id/replay.vrf:/in/replay.vrf:ro" -v "$tool:/opt/tool:ro" \
    -e MATCH_ID="$id" -e SOURCE_BYTES="$bytes" -e SOURCE_SHA256="$sha" -e DECODER_REVISION="$DECODER_REVISION" -e DECODER_PATCH="$DECODER_PATCH" \
    -e HOME=/tmp \
    "$image" sh -c '
      # One pass: oracle verdict, export and compact. Exit 10: no transform
      # (none registered and none solved) or the oracle did not pass; 12: the
      # compact document was refused; anything else is an export failure.
      /opt/tool/vrfkit export /in/replay.vrf --out /work/export --checkpoints --require-pass --solve-unknown \
        --compact /work/compact.json --match-id "$MATCH_ID" --source-bytes "$SOURCE_BYTES" --source-sha256 "$SOURCE_SHA256" \
        --decoder-revision "$DECODER_REVISION" --decoder-patch "$DECODER_PATCH" >/dev/null 2>&1
      s=$?
      if [ $s -eq 10 ] || [ $s -eq 12 ]; then exit $s; elif [ $s -ne 0 ]; then exit 11; fi
      cd /work && tar -cf - compact.json export' \
    | head -c $((cap + 1)) > "$out/result.tar"
  status=${PIPESTATUS[0]}
  docker rm -f "parse-$id" >/dev/null 2>&1 || true
  size=$(stat -c %s "$out/result.tar")
  code=
  if [[ $status -ne 0 || $size -gt $cap ]]; then
    case $status in
      0) code=oversize ;;
      10) code=decoder_validate_failed ;;
      11) code=decoder_export_failed ;;
      12) code=compact_failed ;;
      124|137) code=timeout ;;
      *) code=parser_failed ;;
    esac
  elif ! python3 -I "$tool/replay-unpack.py" "$out/result.tar" "$out"; then
    code=output_rejected
  fi
  rm -f "$out/result.tar"
  [[ -n $code ]] && echo "$code" > "$out/error.txt"
  echo "$id ${code:-ok}"
done
