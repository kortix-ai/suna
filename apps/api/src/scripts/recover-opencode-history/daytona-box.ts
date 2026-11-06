/**
 * The recovery's box cycle on Daytona (legacy provider, operate-only).
 *
 * Daytona's file and exec APIs need a started sandbox, so the cycle is the
 * Platinum one: start (Daytona restores an archived sandbox from its storage
 * first), measure and split the store with `copyScript`, download the parts,
 * then stop and archive again. Kortix
 * does not see the start: the session row stays `stopped` and the box's token
 * stays refused. Every environment shares one Daytona disk quota (learning
 * 2026-10-06), so keep the concurrency low: a started archived box holds its
 * disk until the archive.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sandbox } from '@daytonaio/sdk';
import { getDaytona } from '../../shared/daytona';
import { withTimeout } from '../../shared/with-timeout';
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

const CALL_TIMEOUT_MS = 60_000;
/** Restoring an archived sandbox from Daytona's storage can take minutes. */
const START_TIMEOUT_S = 600;
/** Splitting a store of a few GB on a box restored from archive takes minutes. */
const EXEC_TIMEOUT_S = 300;
const DOWNLOAD_TIMEOUT_S = 300;

const notFound = (err: unknown) => /not found|404/i.test(err instanceof Error ? err.message : String(err));

async function get(externalId: string): Promise<Sandbox> {
  return withTimeout(getDaytona().get(externalId), CALL_TIMEOUT_MS, `Daytona get(${externalId})`);
}

async function state(externalId: string): Promise<BoxState> {
  try {
    const s = String((await get(externalId)).state ?? '').toLowerCase();
    if (s === 'started' || s === 'running') return 'running';
    if (s === 'stopped') return 'stopped';
    if (s === 'archived') return 'archived';
    if (s === 'destroyed' || s === 'destroying' || s === 'error' || s === 'build_failed') return 'gone';
    return 'other';
  } catch (err) {
    if (notFound(err)) return 'gone';
    throw err;
  }
}

const SETTLE_POLL_MS = 5_000;
const START_ATTEMPTS = 3;

/** Waits until the box is running, parked or gone, up to the start budget. */
async function waitSettled(externalId: string): Promise<BoxState> {
  const deadline = Date.now() + START_TIMEOUT_S * 1000;
  for (;;) {
    const s = await state(externalId);
    if (s !== 'other' || Date.now() >= deadline) return s;
    await Bun.sleep(SETTLE_POLL_MS);
  }
}

/**
 * Starts the box. Daytona can answer a start with a 502 or "state change in
 * progress" and still boot the box minutes later (dev, 2026-11-05: 3 of 140
 * starts; one box came up more than a minute after its 502, after the cycle had
 * parked it). So a failed start waits for the box to settle, uses it when it
 * runs, and else starts it again: a late boot is then this cycle's own and
 * `release` parks it.
 */
async function startBox(sandbox: Sandbox, externalId: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await withTimeout(sandbox.start(START_TIMEOUT_S), (START_TIMEOUT_S + 30) * 1000, `Daytona start(${externalId})`);
      return;
    } catch (err) {
      const message = `start failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`;
      if (notFound(err)) throw new RecoverableBoxError(message, false);
      const s = await waitSettled(externalId);
      if (s === 'running') return;
      if (s === 'gone') throw new RecoverableBoxError(message, false);
      if (attempt >= START_ATTEMPTS) throw new RecoverableBoxError(`${message} (${attempt} attempts, box ${s})`, true);
      await Bun.sleep(10_000 * attempt);
    }
  }
}

async function fetchBytes(sandbox: Sandbox, path: string): Promise<Buffer> {
  const bytes = await sandbox.fs.downloadFile(path, DOWNLOAD_TIMEOUT_S);
  if (bytes.length >= MAX_FILE_BYTES) throw new RecoverableBoxError(`a file is at the ${MAX_FILE_BYTES} B download cap`, false);
  return bytes;
}

async function copyStore(externalId: string, localDir: string, maxStoreBytes: number): Promise<StoreCopy> {
  const sandbox = await get(externalId);
  await startBox(sandbox, externalId);
  const exec = await withTimeout(
    sandbox.process.executeCommand(`sh -c '${copyScript(maxStoreBytes).replaceAll("'", `'\\''`)}'`, undefined, undefined, EXEC_TIMEOUT_S),
    (EXEC_TIMEOUT_S + 30) * 1000,
    `Daytona exec(${externalId})`,
  );
  if (exec.exitCode !== 0) throw new RecoverableBoxError(`copy exec exit ${exec.exitCode}: ${(exec.result ?? '').slice(0, 300)}`, true);
  const found = parseCopyOutput(exec.result ?? '');
  if (found.kind !== 'found') return found;
  const fetchPart = (path: string) => retryTransient(() => fetchBytes(sandbox, path), (err) => !notFound(err) && !(err instanceof RecoverableBoxError));
  return { kind: 'copied', ...(await assembleStore(found, localDir, maxStoreBytes, fetchPart)) };
}

async function copySidecars(externalId: string, paths: string[], localDir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (paths.length === 0) return out;
  const sandbox = await get(externalId);
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  for (const [i, path] of paths.entries()) {
    if (!isSafeBoxPath(path)) continue;
    const to = join(localDir, `sidecar-${i}`);
    try {
      const bytes = await fetchBytes(sandbox, path);
      await writeFile(to, bytes, { mode: 0o600 });
      out.set(path, bytes);
    } catch (err) {
      if (notFound(err)) continue;
      throw err;
    }
  }
  return out;
}

async function release(externalId: string, stillParked: () => Promise<boolean>): Promise<'parked' | 'left-running'> {
  const sandbox = await get(externalId).catch(() => null);
  if (!sandbox) return 'parked';
  // Only a running box takes an exec. A box another writer stopped keeps its copy
  // until the next attempt's copy script removes it.
  if ((await state(externalId).catch(() => 'other')) === 'running') {
    await withTimeout(sandbox.process.executeCommand(`sh -c 'rm -rf ${BOX_TEMP_GLOB}'`, undefined, undefined, 20), 50_000, 'Daytona rm').catch(() => undefined);
  }
  // Same rule as Platinum: read as late as possible, and give a box a wake
  // claimed after the stop back by starting it again.
  const giveBack = async (): Promise<'left-running'> => {
    await withTimeout(sandbox.start(START_TIMEOUT_S), (START_TIMEOUT_S + 30) * 1000, `Daytona start(${externalId})`).catch(() => undefined);
    return 'left-running';
  };
  if (!(await stillParked())) return 'left-running';
  // A box still starting refuses a stop ("state change in progress"): wait for it.
  const s = await waitSettled(externalId);
  if (s === 'gone' || s === 'stopped' || s === 'archived') return (await stillParked()) ? 'parked' : 'left-running';
  if (!(await stillParked())) return 'left-running';
  await withTimeout(sandbox.stop(CALL_TIMEOUT_MS / 1000), CALL_TIMEOUT_MS + 10_000, `Daytona stop(${externalId})`);
  if (!(await stillParked())) return giveBack();
  // Best effort: archiving frees the disk the start restored (the shared quota).
  await withTimeout(sandbox.archive(), CALL_TIMEOUT_MS, `Daytona archive(${externalId})`).catch(() => undefined);
  if (!(await stillParked())) return giveBack();
  return 'parked';
}

export const daytonaBox: BoxReader = { state, copyStore, copySidecars, release, throttledForMs: () => 0 };
