/**
 * The recovery's box cycle on Daytona (legacy provider, operate-only).
 *
 * Daytona's file and exec APIs need a started sandbox, so the cycle is the
 * Platinum one: start (Daytona restores an archived sandbox from its storage
 * first), copy with `COPY_SCRIPT`, download, then stop and archive again. Kortix
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
  COPY_SCRIPT,
  isSafeBoxPath,
  MAX_FILE_BYTES,
  parseCopyOutput,
  RecoverableBoxError,
  type BoxReader,
  type BoxState,
  type CopiedStore,
} from './box';

const CALL_TIMEOUT_MS = 60_000;
/** Restoring an archived sandbox from Daytona's storage can take minutes. */
const START_TIMEOUT_S = 600;
const EXEC_TIMEOUT_S = 60;
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

async function download(sandbox: Sandbox, path: string, to: string): Promise<number> {
  const bytes = await sandbox.fs.downloadFile(path, DOWNLOAD_TIMEOUT_S);
  if (bytes.length >= MAX_FILE_BYTES) throw new RecoverableBoxError(`a store file is at the ${MAX_FILE_BYTES} B download cap`, false);
  await writeFile(to, bytes, { mode: 0o600 });
  return bytes.length;
}

async function copyStore(externalId: string, localDir: string): Promise<CopiedStore | null> {
  const sandbox = await get(externalId);
  try {
    await withTimeout(sandbox.start(START_TIMEOUT_S), (START_TIMEOUT_S + 30) * 1000, `Daytona start(${externalId})`);
  } catch (err) {
    throw new RecoverableBoxError(`start failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`, !notFound(err));
  }
  const exec = await withTimeout(
    sandbox.process.executeCommand(`sh -c '${COPY_SCRIPT.replaceAll("'", `'\\''`)}'`, undefined, undefined, EXEC_TIMEOUT_S),
    (EXEC_TIMEOUT_S + 30) * 1000,
    `Daytona exec(${externalId})`,
  );
  if (exec.exitCode !== 0) throw new RecoverableBoxError(`copy exec exit ${exec.exitCode}: ${(exec.result ?? '').slice(0, 300)}`, true);
  const found = parseCopyOutput(exec.result ?? '');
  if (!found) return null;
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const dbPath = join(localDir, 'opencode.db');
  let bytes = await download(sandbox, `${found.boxTemp}/opencode.db`, dbPath);
  try {
    bytes += await download(sandbox, `${found.boxTemp}/opencode.db-wal`, `${dbPath}-wal`);
  } catch (err) {
    if (!notFound(err)) throw err; // no WAL: the store was checkpointed
  }
  return { dbPath, bytes, ...found };
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
      await download(sandbox, path, to);
      out.set(path, Buffer.from(await Bun.file(to).bytes()));
    } catch (err) {
      if (notFound(err)) continue;
      throw err;
    }
  }
  return out;
}

async function release(externalId: string, boxTemp: string | null, stillParked: () => Promise<boolean>): Promise<'parked' | 'left-running'> {
  const sandbox = await get(externalId).catch(() => null);
  if (!sandbox) return 'parked';
  if (boxTemp) {
    await withTimeout(sandbox.process.executeCommand(`rm -rf ${boxTemp}`, undefined, undefined, 20), 50_000, 'Daytona rm').catch(() => undefined);
  }
  if (!(await stillParked())) return 'left-running';
  const s = await state(externalId);
  if (s === 'gone' || s === 'stopped' || s === 'archived') return 'parked';
  await withTimeout(sandbox.stop(CALL_TIMEOUT_MS / 1000), CALL_TIMEOUT_MS + 10_000, `Daytona stop(${externalId})`);
  // Best effort: archiving frees the disk the start restored (the shared quota).
  await withTimeout(sandbox.archive(), CALL_TIMEOUT_MS, `Daytona archive(${externalId})`).catch(() => undefined);
  return 'parked';
}

export const daytonaBox: BoxReader = { state, copyStore, copySidecars, release, throttledForMs: () => 0 };
