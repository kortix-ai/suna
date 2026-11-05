/**
 * What the recovery needs from a sandbox provider: read a parked box's state,
 * boot it and copy its OpenCode store out, then park it again. One reader per
 * provider (`platinum-box.ts`, `daytona-box.ts`); the cycle is the same.
 */

export type BoxState = 'running' | 'stopped' | 'archived' | 'gone' | 'other';

export class RecoverableBoxError extends Error {
  constructor(
    message: string,
    /** True when a later run may succeed (a 409 race, a timeout, the provider busy). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface CopiedStore {
  /** Local path of the downloaded `opencode.db` (its `-wal` sits beside it when the box had one). */
  dbPath: string;
  /** The pinned OpenCode root id the box recorded, when it has one. */
  pinnedRoot: string | null;
  home: string;
  /** The temp folder inside the box, for `release`. */
  boxTemp: string;
  bytes: number;
}

export interface BoxReader {
  state(externalId: string): Promise<BoxState>;
  /** Boots the box and downloads its OpenCode store into `localDir`. Null when the box holds no store. */
  copyStore(externalId: string, localDir: string): Promise<CopiedStore | null>;
  /** Downloads each offloaded attachment the store names. A missing one stays unresolved. */
  copySidecars(externalId: string, paths: string[], localDir: string): Promise<Map<string, Buffer>>;
  /**
   * Removes the temp copy in the box, then stops and archives the box when
   * `stillParked()` (read right before the stop) says Kortix still holds the row
   * as stopped. A row a person woke meanwhile keeps its running box.
   */
  release(externalId: string, boxTemp: string | null, stillParked: () => Promise<boolean>): Promise<'parked' | 'left-running'>;
  /** Milliseconds the provider has throttled without a success in between; 0 when it is not. */
  throttledForMs(): number;
}

/**
 * Copies `opencode.db` and its `-wal` into a temp folder in one moment (so the
 * pair is consistent) and prints `found|<temp>|<home>|<pinned root>`. The homes
 * OpenCode used: `/home/kortix` from 2026-07-26, `/opt/kortix/home` before.
 * `auth.json` beside the store is never read. It first removes the copy an
 * earlier attempt left when the box was stopped before `release` ran.
 */
export const COPY_SCRIPT = `set -e
rm -rf /tmp/kortix-recover.*
for h in /home/kortix /opt/kortix/home /root; do
  d="$h/.local/share/opencode"
  if [ -f "$d/opencode.db" ]; then
    t=$(mktemp -d /tmp/kortix-recover.XXXXXX)
    cp "$d/opencode.db" "$t/opencode.db"
    if [ -f "$d/opencode.db-wal" ]; then cp "$d/opencode.db-wal" "$t/opencode.db-wal"; fi
    chmod -R a+r "$t"
    p=""
    if [ -f "$h/.local/state/kortix/opencode-session-id" ]; then p=$(head -c 200 "$h/.local/state/kortix/opencode-session-id" | tr -d '\\n\\r '); fi
    echo "found|$t|$h|$p"
    exit 0
  fi
done
echo "none"`;

/** The copy script's last line, checked. Null when the box holds no store. */
export function parseCopyOutput(stdout: string): { boxTemp: string; home: string; pinnedRoot: string | null } | null {
  const line = stdout.trim().split('\n').pop() ?? '';
  if (line === 'none') return null;
  const [tag, boxTemp, home, pin] = line.split('|');
  if (tag !== 'found' || !boxTemp?.startsWith('/tmp/kortix-recover.') || !home) {
    throw new RecoverableBoxError(`unexpected copy output: ${line.slice(0, 200)}`, false);
  }
  return { boxTemp, home, pinnedRoot: pin && /^ses_[A-Za-z0-9]+$/.test(pin) ? pin : null };
}

/** Platinum's per-request download cap (its filesystem API limits); the same bound for Daytona. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * A sidecar path comes from the store's own rows, so it is only ever downloaded
 * from the daemon's attachment folder (`<home>/.local/share/kortix/attachments/`):
 * never `auth.json` or any other file of the box.
 */
export const isSafeBoxPath = (path: string) =>
  /^\/(home\/kortix|opt\/kortix\/home|root)\/\.local\/share\/kortix\/attachments\/[^/]+$/.test(path) && !path.split('/').includes('..');

/** A store this large is set aside (`too_large`): the conversion holds it in memory several times over. */
export const MAX_STORE_BYTES = 128 * 1024 * 1024;
