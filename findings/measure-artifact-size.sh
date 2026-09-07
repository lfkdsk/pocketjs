#!/usr/bin/env bash
# scout-artifact-size measurement harness. Usage: measure.sh <run-tag>
set -uo pipefail
RUN="${1:?usage: measure.sh <run-tag>}"
ROOT="${VAPOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
OUT="${OUT_BASE:-/tmp/t405}/$RUN"
export MGBA_PREFIX=/tmp/mgba-prefix
export CC65_LIB=/home/linuxbrew/.linuxbrew/share/cc65/lib/none.lib
cd "$ROOT" || exit 1
rm -rf "$OUT"; mkdir -p "$OUT"

for ex in vapor/examples/todo/todo.tsx vapor/examples/playdate-six-button/playdate-six-button.tsx; do
  n=$(basename "$ex" .tsx)
  for tgt in gba gb nes; do
    d="$OUT/$n-$tgt"
    bun vapor/compiler/cli.ts "$ex" --target "$tgt" --out "$d" >"$OUT/$n-$tgt.log" 2>&1
    art=$(ls "$d"/$n.$tgt 2>/dev/null)
    if [ -n "$art" ]; then
      occ=$(python3 - "$art" "$tgt" <<'PY'
import sys
d=open(sys.argv[1],'rb').read(); t=sys.argv[2]
if t=='gb':
    i=len(d)-1
    while i>=0 and d[i]==0xFF: i-=1
    print(i+1)
elif t=='nes':
    p=d[16:16+32768]; best=run=0
    for b in p:
        if b==0xFF: run+=1
        else: best=max(best,run); run=0
    print(len(p)-max(best,run))
else:
    print(len(d))
PY
)
      printf '%-22s %-4s %8d bytes  occupancy %6s  sha=%s\n' "$n" "$tgt" "$(stat -c%s "$art")" \
        "$occ" "$(sha256sum "$art" | cut -c1-12)"
    else
      printf '%-22s %-4s BUILD FAILED\n' "$n" "$tgt"
    fi
  done
done
