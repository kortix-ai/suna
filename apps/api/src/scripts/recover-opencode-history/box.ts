/**
 * What the recovery needs from a sandbox provider: read a parked box's state,
 * boot it and copy its OpenCode store out, then park it again. One reader per
 * provider (`platinum-box.ts`, `daytona-box.ts`); the cycle is the same.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  bytes: number;
}

/** What `copyStore` found: no store, a store over the run's cap (not copied), or the downloaded copy. */
export type StoreCopy = { kind: 'none' } | { kind: 'too_large'; bytes: number } | ({ kind: 'copied' } & CopiedStore);

export interface BoxReader {
  state(externalId: string): Promise<BoxState>;
  /** Boots the box and downloads its OpenCode store into `localDir`, unless the store is over `maxStoreBytes`. */
  copyStore(externalId: string, localDir: string, maxStoreBytes: number): Promise<StoreCopy>;
  /** Downloads each offloaded attachment the store names. A missing one stays unresolved. */
  copySidecars(externalId: string, paths: string[], localDir: string): Promise<Map<string, Buffer>>;
  /**
   * Removes every temp copy in the box (`BOX_TEMP_GLOB`, also the one a failed
   * download left), then stops and archives the box when `stillParked()` (read
   * right before the stop) says Kortix still holds the row as stopped. A row a
   * person woke meanwhile keeps its running box.
   */
  release(externalId: string, stillParked: () => Promise<boolean>): Promise<'parked' | 'left-running'>;
  /** Milliseconds the provider has throttled without a success in between; 0 when it is not. */
  throttledForMs(): number;
}

/** Platinum's per-request download cap (its filesystem API limits); the same bound for Daytona. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** The box splits each store file into parts of this size, under the download cap. */
export const PART_BYTES = 200 * 1024 * 1024;
/**
 * The default store cap. A larger store is set aside (`too_large`) and not copied:
 * the conversion holds it in memory several times over. A run with
 * `--max-store-mb` above it takes those sessions again, one at a time.
 */
export const MAX_STORE_BYTES = 128 * 1024 * 1024;
/** Every temp folder the copy script makes; `release` removes them all. */
export const BOX_TEMP_GLOB = '/tmp/kortix-recover.*';

const STORE_FILES = ['opencode.db', 'opencode.db-wal'] as const;

/**
 * The script one exec runs in the box. It finds OpenCode's store (the homes
 * OpenCode used: `/home/kortix` from 2026-07-26, `/opt/kortix/home` before) and
 * measures `opencode.db` + `-wal`. Over `maxStoreBytes` it prints
 * `too_large|<bytes>` and copies nothing. Else it splits each file into
 * `PART_BYTES` parts in a temp folder (no writer runs: OpenCode is gone from the
 * box, so the pair stays consistent) and prints `file|<name>|<bytes>` per file,
 * `part|<name>` per part, then `found|<temp>|<home>|<pinned root>`.
 * `auth.json` beside the store is never read. It first removes the copy an
 * earlier attempt left, and a failure removes its own.
 */
export function copyScript(maxStoreBytes: number): string {
  if (!Number.isSafeInteger(maxStoreBytes) || maxStoreBytes <= 0) throw new Error('maxStoreBytes must be a positive integer');
  return `set -e
rm -rf ${BOX_TEMP_GLOB}
t=""
trap '[ $? -eq 0 ] || rm -rf "$t"' EXIT
for h in /home/kortix /opt/kortix/home /root; do
  d="$h/.local/share/opencode"
  if [ -f "$d/opencode.db" ]; then
    n=0
    for f in ${STORE_FILES.join(' ')}; do
      if [ -f "$d/$f" ]; then n=$((n + $(wc -c < "$d/$f"))); fi
    done
    if [ "$n" -gt ${maxStoreBytes} ]; then echo "too_large|$n"; exit 0; fi
    t=$(mktemp -d /tmp/kortix-recover.XXXXXX)
    for f in ${STORE_FILES.join(' ')}; do
      if [ -f "$d/$f" ]; then
        echo "file|$f|$(wc -c < "$d/$f" | tr -d ' ')"
        if [ -s "$d/$f" ]; then split -b ${PART_BYTES} -a 3 "$d/$f" "$t/$f.part."; fi
      fi
    done
    chmod -R a+r "$t"
    ls -1 "$t" | sed 's/^/part|/'
    p=""
    if [ -f "$h/.local/state/kortix/opencode-session-id" ]; then p=$(head -c 200 "$h/.local/state/kortix/opencode-session-id" | tr -d '\\n\\r '); fi
    echo "found|$t|$h|$p"
    exit 0
  fi
done
echo "none"`;
}

export interface StoreFile {
  name: (typeof STORE_FILES)[number];
  bytes: number;
  /** Part file names in the temp folder, in byte order. */
  parts: string[];
}

export type CopyOutput =
  | { kind: 'none' }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'found'; boxTemp: string; home: string; pinnedRoot: string | null; files: StoreFile[] };

/** The copy script's output, checked: every file it measured must list exactly its parts. */
export function parseCopyOutput(stdout: string): CopyOutput {
  const lines = stdout.trim().split('\n').map((l) => l.trim());
  const last = lines.at(-1) ?? '';
  if (last === 'none') return { kind: 'none' };
  const tooLarge = /^too_large\|(\d+)$/.exec(last);
  if (tooLarge) return { kind: 'too_large', bytes: Number(tooLarge[1]) };
  const [tag, boxTemp, home, pin] = last.split('|');
  // Exactly what `mktemp -d /tmp/kortix-recover.XXXXXX` makes: no `/`, no `..`.
  if (tag !== 'found' || !/^\/tmp\/kortix-recover\.[A-Za-z0-9]+$/.test(boxTemp ?? '') || !home) {
    throw new RecoverableBoxError(`unexpected copy output: ${last.slice(0, 200)}`, false);
  }
  const parts = lines.filter((l) => /^part\|opencode\.db(-wal)?\.part\.[a-z]{3}$/.test(l)).map((l) => l.slice('part|'.length));
  const files: StoreFile[] = [];
  for (const line of lines) {
    const m = /^file\|(opencode\.db|opencode\.db-wal)\|(\d+)$/.exec(line);
    if (!m) continue;
    const name = m[1] as StoreFile['name'];
    const bytes = Number(m[2]);
    const own = parts.filter((p) => p.startsWith(`${name}.part.`)).sort();
    if (own.length !== Math.ceil(bytes / PART_BYTES)) {
      throw new RecoverableBoxError(`${name}: ${own.length} parts listed for ${bytes} bytes`, true);
    }
    files.push({ name, bytes, parts: own });
  }
  if (!files.some((f) => f.name === 'opencode.db')) throw new RecoverableBoxError('copy output lists no opencode.db', false);
  return { kind: 'found', boxTemp, home, pinnedRoot: pin && /^ses_[A-Za-z0-9]+$/.test(pin) ? pin : null, files };
}

/**
 * Runs `call` up to `attempts` times while `transient(err)` holds, waiting 2 s,
 * then 4 s. A part download is minutes of transfer: dev, 2026-11-06, one of 4
 * big-store downloads died on a connection reset and passed on the next try.
 */
export async function retryTransient<T>(call: () => Promise<T>, transient: (err: unknown) => boolean, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (err) {
      if (i >= attempts || !transient(err)) throw err;
      await Bun.sleep(2_000 * i);
    }
  }
}

/**
 * Downloads each store file's parts in order into `localDir` and checks that
 * every byte the box measured arrived. A missing part fails the session
 * (`retry`): the store is never read without its `-wal`. The cap is enforced
 * here on the bytes received, too: the box's own measure is tenant-controlled,
 * so it only saves a futile download. A store past the cap here was tampered
 * with and fails for good.
 */
export async function assembleStore(
  found: Extract<CopyOutput, { kind: 'found' }>,
  localDir: string,
  maxStoreBytes: number,
  fetchPart: (boxPath: string) => Promise<Uint8Array>,
): Promise<CopiedStore> {
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  let total = 0;
  for (const file of found.files) {
    const to = join(localDir, file.name);
    await writeFile(to, new Uint8Array(), { mode: 0o600 });
    let got = 0;
    for (const part of file.parts) {
      const bytes = await fetchPart(`${found.boxTemp}/${part}`);
      if (total + got + bytes.length > maxStoreBytes) throw new RecoverableBoxError(`store past the ${maxStoreBytes} B cap while downloading`, false);
      await appendFile(to, bytes);
      got += bytes.length;
    }
    if (got !== file.bytes) throw new RecoverableBoxError(`${file.name}: ${got} of ${file.bytes} bytes arrived`, true);
    total += got;
  }
  return { dbPath: join(localDir, 'opencode.db'), bytes: total, home: found.home, pinnedRoot: found.pinnedRoot };
}

/**
 * A sidecar path comes from the store's own rows, so it is only ever downloaded
 * from the daemon's attachment folder (`<home>/.local/share/kortix/attachments/`):
 * never `auth.json` or any other file of the box.
 */
export const isSafeBoxPath = (path: string) =>
  /^\/(home\/kortix|opt\/kortix\/home|root)\/\.local\/share\/kortix\/attachments\/[^/]+$/.test(path) && !path.split('/').includes('..');
