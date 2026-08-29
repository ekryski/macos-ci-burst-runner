#!/bin/zsh
set -euo pipefail

minimum_free_gib="${MAC_CI_BURST_MIN_FREE_GIB:-100}"
disk_volume="${MAC_CI_BURST_DISK_VOLUME:-/System/Volumes/Data}"
free_gib="$(df -Pk "$disk_volume" | awk 'NR == 2 { printf "%d", $4 / 1024 / 1024 }')"

if (( free_gib < minimum_free_gib )); then
  print -u2 "CI admission denied: ${free_gib} GiB free; ${minimum_free_gib} GiB required"
  exit 75
fi

print "CI disk admission passed: ${free_gib} GiB free"
