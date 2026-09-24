#!/usr/bin/env bash
# /tmp maintenance for a running sandbox. Runs as root through the provider's
# exec channel (tmp-maintenance.ts renders the placeholders). Idempotent.
#
# Why: Platinum's pt-init mounts /tmp as a tmpfs at 50% of RAM. A guest has no
# swap and a memory snapshot keeps tmpfs across stop/start, so everything
# written to /tmp is RAM the agent never gets back. Prod 2026-09-24: 2 of 17
# active 4 GiB sandboxes had /tmp full (1.96 GiB) and the memory guard stopped
# their turns. Platinum PR #1255 fixes new templates; this converges the boxes
# that already exist.
#
# Modes:
#   report   measure what clean/migrate would free; change nothing
#   clean    delete abandoned uploads, aged files, and trim a crowded /tmp
#   migrate  clean, then move a tmpfs /tmp onto a size-capped disk image
#            (the same image and options as Platinum's pt-init since #1255)
#
# The last stdout line is one JSON report. Everything else goes to stderr.
set -u
export LC_ALL=C

MODE='__MODE__'
TMP='__TMP_DIR__'
ALLOW_MIGRATE='__ALLOW_MIGRATE__'
IMG=/var/lib/pt-tmp.ext4
STAGE=/var/lib/pt-tmp.stage
OLD=/run/pt-tmp.old

log() { printf '[tmp-maintenance] %s\n' "$*" >&2; }
num() { case "${1:-}" in ''|*[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }
meminfo() { awk -v k="$1:" '$1 == k {print $2}' /proc/meminfo 2>/dev/null; }
tmp_fs() { awk -v m="$TMP" '$2 == m {t = $3} END {print t ? t : "dir"}' /proc/mounts 2>/dev/null; }
df_field() { df -Pk "$1" 2>/dev/null | awk -v f="$2" 'NR == 2 {print $f}'; }
# Allocated KiB of the files a find expression selects (%b = 512-byte blocks).
blocks_kb() { awk '{s += $1} END {print int(s / 2)}'; }

GNU=0
if find --version 2>/dev/null | grep -q 'GNU findutils'; then GNU=1; fi

FS=$(tmp_fs)
MEM_TOTAL=$(num "$(meminfo MemTotal)")
SHMEM_BEFORE=$(num "$(meminfo Shmem)")
USED_BEFORE=$(num "$(df_field "$TMP" 3)")
PARTIALS_KB=0; PARTIALS_N=0; AGED_KB=0; AGED_N=0; EVICT_KB=0; EVICT_N=0
MIGRATED=false; BLOCKER=''; ERROR=''

# 1. Abandoned legacy-transfer uploads. The importer staged each archive in
#    $TMP/kortix-legacy-<session>/ and left a `.transfer-*` temp file (plus
#    `.part`) behind every failed attempt. An hour without a write means no
#    upload is still running.
#    Every cleanup step needs GNU find (-printf, and busybox 1.36 ignores
#    -ctime); without it the script measures nothing and deletes nothing.
partials() { find "$TMP" -mindepth 2 -maxdepth 2 -path "$TMP/kortix-legacy-*" -type f -name '*.transfer-*' -mmin +60 "$@" 2>/dev/null; }
if [ "$GNU" = 1 ]; then
  PARTIALS_KB=$(partials -printf '%b\n' | blocks_kb)
  PARTIALS_N=$(partials -printf '.' | wc -c | tr -d ' ')
  [ "$MODE" = report ] || partials -delete
fi

# 2. Age: what nobody read, wrote or changed in 10 days (systemd-tmpfiles'
#    /tmp default). -ctime is what keeps a just-extracted archive with its
#    original mtimes.
if [ "$GNU" = 1 ]; then
  aged() { find "$TMP" -xdev -mindepth 1 \( -type f -o -type l \) -atime +10 -mtime +10 -ctime +10 "$@" 2>/dev/null; }
  AGED_KB=$(aged -printf '%b\n' | blocks_kb)
  AGED_N=$(aged -printf '.' | wc -c | tr -d ' ')
  if [ "$MODE" != report ]; then
    aged -delete
    find "$TMP" -xdev -mindepth 1 -type d -empty -mtime +10 -ctime +10 -delete 2>/dev/null
  fi
fi

# 3. Migrate a tmpfs /tmp onto a size-capped disk image. Only on an idle
#    runtime (the caller checks), only where no process listens on a socket
#    under /tmp (a client connecting by path would reach a dead copy), and
#    only when the disk has room.
# "<pid>\t<path>" for every lock held on a file under /tmp (/proc/locks names
# the file by device and inode). A lock is a process's claim on that exact
# file; a copy on another filesystem is unlocked, so moving /tmp would let a
# second instance of a flock-guarded singleton start.
tmp_locked() {
  local dev
  # `mountpoint -d` prints "is not a mountpoint" on stdout; ask only for a mount.
  dev=''
  if mountpoint -q "$TMP" 2>/dev/null; then
    dev=$(mountpoint -d "$TMP" | awk -F: '{printf "%02x:%02x", $1, $2}')
  fi
  find "$TMP" -xdev -printf '%i\t%p\n' 2>/dev/null \
    | awk -F '\t' -v dev="$dev" 'FNR == NR {path[$1] = $2; next}
        /->/ {next}
        {split($0, f, " "); n = split(f[6], d, ":"); md = d[1] ":" d[2]
         if ((dev == "" || md == dev) && (d[n] in path)) print f[5] "\t" path[d[n]]}' - /proc/locks 2>/dev/null
}

# Platinum's host keeps one RX keepalive per guest with
# `setsid flock -n /tmp/pt-ka.lock pt-ka <gw>` after every memory restore.
# After the switch the old keepalive holds a lock on the old file; stop it and
# relaunch the same command on the new /tmp, so exactly one holds the new lock
# (if the host already started one, `flock -n` makes the relaunch a no-op).
KA_LOCK="$TMP/pt-ka.lock"
restart_keepalive() {
  local pid argv
  for pid in "$@"; do
    [ -r "/proc/$pid/cmdline" ] || continue
    mapfile -d '' argv < "/proc/$pid/cmdline"
    [ "${argv[0]##*/}" = flock ] || continue
    kill $(pgrep -P "$pid") "$pid" 2>/dev/null
    setsid "${argv[@]}" </dev/null >/dev/null 2>&1 &
  done
}

# The image cap, in KiB: 25% of the rootfs, at least 1 GiB, never within 1 GiB
# of a full disk (pt-init's rule). 0 = the disk has no room for one.
rootfs_cap() {
  set -- $(df -Pk / 2>/dev/null | awk 'NR == 2 {print $2, $4}')
  [ -n "${2:-}" ] || { echo 0; return; }
  local cap=$(( $1 / 4 ))
  [ "$cap" -ge 1048576 ] || cap=1048576
  [ "$cap" -le $(( $2 - 1048576 )) ] || cap=$(( $2 - 1048576 ))
  [ "$cap" -ge 262144 ] || cap=0
  echo "$cap"
}
migrate_blocker() {
  [ "$TMP" = /tmp ] || { echo not-tmp; return; }
  [ "$(tmp_fs)" = tmpfs ] || { echo not-tmpfs; return; }
  for t in mkfs.ext4 truncate mount umount cp; do command -v "$t" >/dev/null 2>&1 || { echo "no-$t"; return; }; done
  [ -e /dev/loop-control ] || [ -e /dev/loop0 ] || { echo no-loop; return; }
  if awk 'NR > 1 && $NF ~ /^\/tmp\//' /proc/net/unix 2>/dev/null | grep -q .; then echo sockets; return; fi
  if tmp_locked | awk -F '\t' -v ka="$KA_LOCK" '$2 != ka' | grep -q .; then echo locks; return; fi
  [ "$CAP" -gt 0 ] || { echo disk-full; return; }
  local used; used=$(num "$(df_field /tmp 3)")
  [ $(( used * 10 )) -le $(( CAP * 7 )) ] || { echo too-big; return; }
  echo ''
}

migrate() {
  rm -f "$IMG"
  mkdir -p "${IMG%/*}" "$STAGE" "$OLD" || return 1
  truncate -s "$(( CAP * 1024 ))" "$IMG" || return 1
  mkfs.ext4 -q -F -m 0 -O ^has_journal -E lazy_itable_init=1,nodiscard "$IMG" || return 1
  mount -t ext4 -o loop,discard,relatime,nosuid,nodev "$IMG" "$STAGE" || return 1
  if ! cp -a /tmp/. "$STAGE"/; then umount "$STAGE"; return 1; fi
  # Keep a handle on the tmpfs, put the disk over /tmp, then empty the tmpfs.
  mount --bind /tmp "$OLD" || { umount "$STAGE"; return 1; }
  if ! mount --bind "$STAGE" /tmp; then umount "$OLD"; umount "$STAGE"; return 1; fi
  umount "$STAGE"
  chmod 1777 /tmp
  # Files written between the copy and the switch.
  cp -a -n "$OLD"/. /tmp/ 2>/dev/null
  # A file some process still holds open stays in RAM until it is closed.
  find "$OLD" -xdev -mindepth 1 -delete 2>/dev/null
  umount -l "$OLD"
  rmdir "$OLD" "$STAGE" 2>/dev/null
  return 0
}

CAP=$(num "$(rootfs_cap)")
if [ "$MODE" = migrate ] && [ "$ALLOW_MIGRATE" = 1 ]; then
  BLOCKER=$(migrate_blocker)
  if [ -z "$BLOCKER" ]; then
    KA_PIDS=$(tmp_locked | awk -F '\t' -v ka="$KA_LOCK" '$2 == ka {print $1}')
    if migrate; then
      MIGRATED=true
      # shellcheck disable=SC2086
      restart_keepalive $KA_PIDS
    else
      ERROR='migrate failed'; rm -f "$IMG"
    fi
  fi
elif [ "$MODE" = report ] && [ "$ALLOW_MIGRATE" = 1 ]; then
  BLOCKER=$(migrate_blocker)
fi

# 4. Pressure: trim the least recently read files, never one used in the last
#    hour. A tmpfs costs RAM, so it is judged against RAM: above 25% of it,
#    down to 15%. A disk /tmp is judged against itself: above 80%, down to 60%.
FS_AFTER=$(tmp_fs)
USED=$(num "$(df_field "$TMP" 3)")
SIZE=$(num "$(df_field "$TMP" 2)")
if [ "$FS_AFTER" = tmpfs ]; then
  TRIGGER=$(( MEM_TOTAL * 25 / 100 )); TARGET=$(( MEM_TOTAL * 15 / 100 ))
else
  TRIGGER=$(( SIZE * 80 / 100 )); TARGET=$(( SIZE * 60 / 100 ))
fi
if [ "$GNU" = 1 ] && [ "$TRIGGER" -gt 0 ] && [ "$USED" -gt "$TRIGGER" ]; then
  NEED=$(( (USED - TARGET) * 1024 ))
  victims() {
    find "$TMP" -xdev -mindepth 1 -type f -amin +60 -mmin +60 -cmin +60 \
        ! -name "$(printf '*\n*')" -printf '%A@\t%b\t%p\n' 2>/dev/null \
      | sort -n \
      | awk -F '\t' -v need="$NEED" 'freed >= need {exit}
          {freed += $2 * 512; print}'
  }
  PICK=$(victims)
  EVICT_KB=$(printf '%s\n' "$PICK" | awk -F '\t' 'NF >= 3 {s += $2} END {print int(s / 2)}')
  EVICT_N=$(printf '%s\n' "$PICK" | awk -F '\t' 'NF >= 3' | wc -l | tr -d ' ')
  if [ "$MODE" != report ] && [ -n "$PICK" ]; then
    printf '%s\n' "$PICK" | awk -F '\t' 'NF >= 3 {sub(/^[^\t]*\t[^\t]*\t/, ""); print}' \
      | xargs -d '\n' -r rm -f --
  fi
fi

sync 2>/dev/null
USED_AFTER=$(num "$(df_field "$TMP" 3)")
SHMEM_AFTER=$(num "$(meminfo Shmem)")
OK=true; [ -z "$ERROR" ] || OK=false
printf '{"ok":%s,"mode":"%s","gnu":%s,"tmp_fs":"%s","tmp_fs_after":"%s","mem_total_kb":%s,"shmem_before_kb":%s,"shmem_after_kb":%s,"tmp_used_before_kb":%s,"tmp_used_after_kb":%s,"tmp_size_kb":%s,"partials_kb":%s,"partials":%s,"aged_kb":%s,"aged":%s,"evicted_kb":%s,"evicted":%s,"migrated":%s,"migrate_blocker":"%s","error":"%s"}\n' \
  "$OK" "$MODE" "$([ "$GNU" = 1 ] && echo true || echo false)" "$FS" "$(tmp_fs)" \
  "$MEM_TOTAL" "$SHMEM_BEFORE" "$SHMEM_AFTER" "$USED_BEFORE" "$USED_AFTER" "$(num "$(df_field "$TMP" 2)")" \
  "$(num "$PARTIALS_KB")" "$(num "$PARTIALS_N")" "$(num "$AGED_KB")" "$(num "$AGED_N")" \
  "$(num "$EVICT_KB")" "$(num "$EVICT_N")" "$MIGRATED" "$BLOCKER" "$ERROR"
