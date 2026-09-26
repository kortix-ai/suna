#!/usr/bin/env bash

# A Bun isolate worker can hold several GiB by the end of the API suite.
# Keep 2 GiB for the agent and OS, then allow one worker per 4 GiB remaining.
select_api_test_workers() {
  local available_mb="${1:-0}"
  if [[ ! "$available_mb" =~ ^[0-9]+$ ]]; then available_mb=0; fi
  local workers=$(( (available_mb - 2048) / 4096 ))
  if (( workers < 1 )); then workers=1; fi
  if (( workers > 4 )); then workers=4; fi
  printf '%s\n' "$workers"
}

detect_api_test_workers() {
  local available_mb=0 cgroup_max cgroup_current inactive_file cgroup_headroom
  if [[ -r /proc/meminfo ]]; then
    available_mb="$(awk '/^MemAvailable:/ {print int($2 / 1024); exit}' /proc/meminfo)"
  elif command -v vm_stat >/dev/null 2>&1; then
    # macOS: free, inactive and speculative pages are reusable by the suite.
    available_mb="$(vm_stat | awk '
      /page size of/ { page_size=$8 }
      /^Pages free:/ { free=$3 }
      /^Pages inactive:/ { inactive=$3 }
      /^Pages speculative:/ { speculative=$3 }
      END { if (page_size > 0) print int((free + inactive + speculative) * page_size / 1048576) }
    ' | tr -d '.')"
  fi
  if [[ -r /sys/fs/cgroup/memory.max && -r /sys/fs/cgroup/memory.current ]]; then
    read -r cgroup_max < /sys/fs/cgroup/memory.max
    read -r cgroup_current < /sys/fs/cgroup/memory.current
    if [[ "$cgroup_max" =~ ^[0-9]+$ && ${#cgroup_max} -le 15 && "$cgroup_current" =~ ^[0-9]+$ ]]; then
      inactive_file=0
      if [[ -r /sys/fs/cgroup/memory.stat ]]; then
        inactive_file="$(awk '$1 == "inactive_file" {print $2; exit}' /sys/fs/cgroup/memory.stat)"
      fi
      if [[ ! "$inactive_file" =~ ^[0-9]+$ ]]; then inactive_file=0; fi
      if (( inactive_file > cgroup_current )); then inactive_file=$cgroup_current; fi
      cgroup_headroom=$(( (cgroup_max - cgroup_current + inactive_file) / 1048576 ))
      if (( cgroup_headroom < 0 )); then cgroup_headroom=0; fi
      if (( available_mb == 0 || cgroup_headroom < available_mb )); then
        available_mb=$cgroup_headroom
      fi
    fi
  fi
  select_api_test_workers "$available_mb"
}
