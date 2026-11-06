/**
 * The recovery's box cycle on Platinum.
 *
 *   1. `PlatinumProvider.start` restores an archived box from cold storage and
 *      boots it (Platinum keeps the memory image, so old processes resume), then
 *      `waitRunning` waits for `running`: the start returns once Platinum
 *      accepted it. Kortix does not see this start: the session row stays
 *      `stopped`, the box's session token stays refused (no turn, no model
 *      call, no billing), and the sidebar does not move.
 *   2. One exec runs `copyScript` (box.ts): it measures the store and splits
 *      it into parts under Platinum's 256 MiB download cap.
 *   3. `GET /files` downloads the parts and the offloaded attachments.
 *   4. `release` removes the temp copies, then stops (confirmed) and archives
 *      the box when the Kortix row is still parked.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PlatinumProvider } from '../../platform/providers/platinum';
import { PlatinumHttpError, platinumFetch, platinumJson } from '../../shared/platinum';
import {
  assembleStore,
  BOX_TEMP_GLOB,
  copyScript,
  isSafeBoxPath,
  MAX_FILE_BYTES,
  parseCopyOutput,
  RecoverableBoxError,
  retryTransient,
  type BoxReader,
  type BoxState,
  type StoreCopy,
} from './box';

/** Splitting a store of a few GB on a box restored from archive takes minutes. */
const COPY_EXEC_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** Platinum's worst observed restore from archive is ~546 s. */
const START_BUDGET_MS = 10 * 60_000;
const START_POLL_MS = 2_000;
/**
 * `provider.start` returns once the box is booting, so a box that is parked or
 * parking after this grace was stopped by another writer. Dev, 2026-11-05: 8 of
 * 782 boxes went `stopping` 7 s to minutes after the start. One such writer is
 * Kortix's row-VM divergence sweep, which stops a running box whose row says
 * `stopped` (`projects/reaping/row-vm-divergence.ts`). The session gets `retry`.
 */
const STOPPED_AFTER_START_GRACE_MS = 30_000;
const PARKING_STATES = new Set(['stopped', 'stopping', 'archived', 'archiving']);

const provider = new PlatinumProvider();

let throttledSince: number | null = null;

/** Runs `call`, waiting out Platinum 429s (Retry-After, else 5 s), up to `attempts` tries. */
async function paced<T>(call: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      const out = await call();
      throttledSince = null;
      return out;
    } catch (err) {
      if (!(err instanceof PlatinumHttpError) || err.status !== 429 || i >= attempts) throw err;
      throttledSince ??= Date.now();
      const after = /retry-after=(\d+)/.exec(err.message)?.[1];
      await Bun.sleep(Math.min(60, Number(after ?? 5)) * 1000);
    }
  }
}

async function rawState(externalId: string): Promise<string> {
  const box = await paced(() => platinumJson<{ state?: string }>(`/v1/sandboxes/${externalId}`));
  return String(box.state ?? '').toLowerCase();
}

async function state(externalId: string): Promise<BoxState> {
  try {
    const s = await rawState(externalId);
    if (s === 'running') return 'running';
    if (s === 'stopped') return 'stopped';
    if (s === 'archived') return 'archived';
    if (s === 'deleted' || s === 'lost' || s === 'failed-start') return 'gone';
    return 'other';
  } catch (err) {
    if (err instanceof PlatinumHttpError && err.status === 404) return 'gone';
    throw err;
  }
}

/** Waits for `running` after `provider.start` returned. */
async function waitRunning(externalId: string): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + START_BUDGET_MS;
  for (;;) {
    const s = await rawState(externalId);
    if (s === 'running') return;
    if (s === 'deleted' || s === 'failed' || s === 'failed-start' || s === 'lost') {
      throw new RecoverableBoxError(`box went ${s} while starting`, false);
    }
    if (PARKING_STATES.has(s) && Date.now() - startedAt >= STOPPED_AFTER_START_GRACE_MS) {
      throw new RecoverableBoxError(`box ${s} after the start: another writer stopped it`, true);
    }
    if (Date.now() >= deadline) throw new RecoverableBoxError(`box still ${s || 'unknown'} after ${START_BUDGET_MS / 1000}s`, true);
    await Bun.sleep(START_POLL_MS);
  }
}

/** Waits until the box is running, parked or gone: a stop refuses a box still `starting`. */
async function waitSettled(externalId: string): Promise<BoxState> {
  const deadline = Date.now() + START_BUDGET_MS;
  for (;;) {
    const s = await state(externalId);
    if (s !== 'other') return s;
    if (Date.now() >= deadline) throw new RecoverableBoxError(`box not settled after ${START_BUDGET_MS / 1000}s`, true);
    await Bun.sleep(START_POLL_MS);
  }
}

async function fetchBytes(externalId: string, path: string): Promise<Buffer> {
  const res = await paced(async () => {
    const r = await platinumFetch(`/v1/sandboxes/${externalId}/files?path=${encodeURIComponent(path)}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!r.ok) {
      const after = r.headers.get('retry-after');
      throw new PlatinumHttpError(`platinum GET files -> ${r.status} ${(await r.text()).slice(0, 200)}${after ? ` retry-after=${after}` : ''}`, r.status, '');
    }
    return r;
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length >= MAX_FILE_BYTES) throw new RecoverableBoxError(`a file is at the ${MAX_FILE_BYTES} B download cap`, false);
  return bytes;
}

async function copyStore(externalId: string, localDir: string, maxStoreBytes: number): Promise<StoreCopy> {
  try {
    await paced(() => provider.start(externalId));
  } catch (err) {
    const status = err instanceof PlatinumHttpError ? err.status : 0;
    throw new RecoverableBoxError(`start failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`, status !== 404);
  }
  await waitRunning(externalId);
  const exec = await paced(() => provider.exec(externalId, ['sh', '-c', copyScript(maxStoreBytes)], { timeoutMs: COPY_EXEC_TIMEOUT_MS }));
  if (exec.exitCode !== 0) throw new RecoverableBoxError(`copy exec exit ${exec.exitCode}: ${exec.stderr.slice(0, 300)}`, true);
  const found = parseCopyOutput(exec.stdout);
  if (found.kind !== 'found') return found;
  // A network error or a 5xx is worth another try; a 4xx is an answer.
  const transient = (err: unknown) => !(err instanceof RecoverableBoxError) && (!(err instanceof PlatinumHttpError) || err.status >= 500);
  const fetchPart = (path: string) => retryTransient(() => fetchBytes(externalId, path), transient);
  return { kind: 'copied', ...(await assembleStore(found, localDir, maxStoreBytes, fetchPart)) };
}

async function copySidecars(externalId: string, paths: string[], localDir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  for (const [i, path] of paths.entries()) {
    if (!isSafeBoxPath(path)) continue;
    const to = join(localDir, `sidecar-${i}`);
    try {
      const bytes = await fetchBytes(externalId, path);
      await writeFile(to, bytes, { mode: 0o600 });
      out.set(path, bytes);
    } catch (err) {
      if (err instanceof PlatinumHttpError && err.status === 404) continue;
      throw err;
    }
  }
  return out;
}

async function release(externalId: string, stillParked: () => Promise<boolean>): Promise<'parked' | 'left-running'> {
  // Only a running box takes an exec. A box another writer stopped keeps its copy
  // until the next attempt's copy script removes it.
  if ((await state(externalId).catch(() => 'other')) === 'running') {
    await paced(() => provider.exec(externalId, ['sh', '-c', `rm -rf ${BOX_TEMP_GLOB}`], { timeoutMs: 20_000 })).catch(() => undefined);
  }
  // The park read and the stop are not atomic, and no Kortix writer honors a
  // recovery claim. So read as late as possible, and when a wake claimed the row
  // after the stop landed, start the box again: the wake owns it.
  const giveBack = async (): Promise<'left-running'> => {
    await paced(() => provider.start(externalId)).catch(() => undefined);
    return 'left-running';
  };
  if (!(await stillParked())) return 'left-running';
  // A box still booting refuses a stop (409 `starting`), and one another writer is
  // stopping goes to `stopped` by itself: wait for either, then act on the result.
  const s = await waitSettled(externalId);
  if (s === 'gone' || s === 'stopped' || s === 'archived') return (await stillParked()) ? 'parked' : 'left-running';
  if (!(await stillParked())) return 'left-running';
  await paced(() => provider.stop(externalId));
  if (!(await stillParked())) return giveBack();
  // Best effort: an unarchived box restarts Platinum's auto-archive clock, so archive it now.
  await paced(() => platinumJson(`/v1/sandboxes/${externalId}/archive`, { method: 'POST' })).catch(() => undefined);
  if (!(await stillParked())) return giveBack();
  return 'parked';
}

export const platinumBox: BoxReader = {
  state,
  copyStore,
  copySidecars,
  release,
  throttledForMs: () => (throttledSince === null ? 0 : Date.now() - throttledSince),
};
