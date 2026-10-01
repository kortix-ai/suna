/**
 * Ephemeral session sandboxes (project flag `ephemeral_sandboxes`, Platinum only).
 *
 * A session's box is disposable. What the session needs to continue lives on
 * one Platinum volume per session, mounted at SESSION_STATE_MOUNT; the image's
 * entrypoint binds its directories onto the usual paths (/workspace, OpenCode's
 * data and state, the daemon's pins, package caches). See
 * apps/sandbox/entrypoint.sh `mount_session_state`.
 *
 *   stop  = commit the volume, DELETE the box, record the row stopped with no
 *           external id (`retireEphemeralBox`).
 *   wake  = a fresh box from the current image with the same volume mounted;
 *           the daemon adopts the checkout and the pinned OpenCode root.
 *
 * Running processes and memory are lost by design. A box stopped before the
 * flag was on keeps its normal stop/resume once; its next stop copies its
 * state onto the volume first (`migrateBoxStateToVolume`).
 */

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
import { endComputeSession } from '../../billing/services/compute-metering';
import { db } from '../../shared/db';
import { isPlatinumConfigured, platinumFetch } from '../../shared/platinum';

/** Where the session volume is mounted in the guest. */
export const SESSION_STATE_MOUNT = '/mnt/kortix-session';
/** The env var that tells the entrypoint to bind session state from the volume. */
export const SESSION_STATE_ENV = 'KORTIX_PERSIST_ROOT';
/** Sandbox metadata: the session volume this box mounted. */
export const SESSION_STATE_VOLUME_KEY = 'sessionStateVolume';
/** Sandbox metadata: the box a stop deleted (the row keeps no external id after it). */
export const EPHEMERAL_RETIRED_KEY = 'ephemeralRetiredExternalId';

/**
 * Directories the entrypoint binds from the volume, keyed by their name on the
 * volume. The migration of an old box copies the same set.
 */
export const SESSION_STATE_DIRS: ReadonlyArray<readonly [string, string]> = [
  ['workspace', '/workspace'],
  ['opencode-data', '/home/kortix/.local/share/opencode'],
  ['opencode-state', '/home/kortix/.local/state/opencode'],
  ['kortix-state', '/home/kortix/.local/state/kortix'],
];

/** Operator kill switch: KORTIX_EPHEMERAL_SANDBOXES=off keeps every session on stop/resume. */
export function ephemeralSandboxesKillSwitchOff(): boolean {
  const raw = (process.env.KORTIX_EPHEMERAL_SANDBOXES ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'off' || raw === 'false' || raw === 'no';
}

/** Is a NEW box of this project's sessions ephemeral? */
export async function ephemeralSandboxesEnabled(projectId: string, provider: string): Promise<boolean> {
  if (provider !== 'platinum' || !isPlatinumConfigured() || ephemeralSandboxesKillSwitchOff()) return false;
  return projectFeatureFlagEnabled(projectId, 'ephemeral_sandboxes').catch(() => false);
}

/** project_sessions metadata: the session's state lives on this volume (set once, never cleared). */
export const SESSION_STATE_SESSION_KEY = 'ephemeral_state_volume';

async function sessionStateVolumeOf(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const v = (row?.metadata as Record<string, unknown> | null | undefined)?.[SESSION_STATE_SESSION_KEY];
  return typeof v === 'string' && v ? v : null;
}

async function recordSessionStateVolume(sessionId: string, volume: string): Promise<void> {
  await db
    .update(projectSessions)
    .set({
      metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ [SESSION_STATE_SESSION_KEY]: volume })}::jsonb`,
    })
    .where(eq(projectSessions.sessionId, sessionId));
}

/**
 * The session-state mount for a new box of this session, or null for a
 * stop/resume session. A session whose state is already on a volume always
 * gets it back (flag or kill switch notwithstanding: booting it without the
 * volume would lose its files); otherwise the project flag decides.
 */
export async function resolveSessionStateMount(input: {
  projectId: string;
  sessionId: string;
  provider: string;
}): Promise<{ volume: string; mountPath: string; env: Record<string, string>; waitedMs: number; generation: number } | null> {
  if (input.provider !== 'platinum' || !isPlatinumConfigured()) return null;
  const existing = await sessionStateVolumeOf(input.sessionId);
  if (!existing && !(await ephemeralSandboxesEnabled(input.projectId, input.provider))) return null;
  const t0 = Date.now();
  const volume = await ensureSessionStateVolume(input.sessionId);
  if (!existing) await recordSessionStateVolume(input.sessionId, volume);
  // A previous box's final commit must land first, or this box mounts a stale head.
  let held = await awaitVolumeReleased(volume, 60_000);
  if (held.length && (await evictOrphanBoxes(input.sessionId, held))) {
    held = await awaitVolumeReleased(volume, 60_000);
  }
  if (held.length) {
    throw new Error(
      `session volume ${volume} is still held by ${held.map((h) => `${h.sandbox_id}:${h.state}`).join(', ')}`,
    );
  }
  return {
    volume,
    mountPath: SESSION_STATE_MOUNT,
    env: { [SESSION_STATE_ENV]: SESSION_STATE_MOUNT },
    waitedMs: Date.now() - t0,
    generation: await nextBoxGeneration(input.sessionId),
  };
}

/**
 * A box of this same session that still holds the session volume while the
 * session has no live box: a failed boot whose cleanup could not reach
 * Platinum. Retire it (commit, then delete) instead of waiting on it forever.
 * True when one was retired.
 */
async function evictOrphanBoxes(sessionId: string, holders: VolumeMountRow[]): Promise<boolean> {
  const [row] = await db
    .select({ externalId: sessionSandboxes.externalId, status: sessionSandboxes.status })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  let evicted = false;
  for (const holder of holders) {
    if (row?.externalId === holder.sandbox_id && row.status === 'active') continue;
    let name = '';
    try {
      const res = await call(`/v1/sandboxes/${encodeURIComponent(holder.sandbox_id)}`, { timeoutMs: 10_000 });
      name = String(((await res.json()) as { name?: string }).name ?? '');
    } catch {
      continue;
    }
    if (!name.startsWith(`kortix-${sessionId}`)) continue;
    console.warn(`[ephemeral] retiring orphan box ${holder.sandbox_id} of session ${sessionId} that still holds its volume`);
    try {
      await retireEphemeralBox({ externalId: holder.sandbox_id, sessionId, metadata: { [SESSION_STATE_VOLUME_KEY]: sessionStateVolumeName(sessionId) } });
      evicted = true;
    } catch (err) {
      console.warn(`[ephemeral] retiring orphan box ${holder.sandbox_id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return evicted;
}

/**
 * One more box for this session. Platinum's create dedup keys on (sandbox id,
 * template, attempt), and every box of an ephemeral session shares the sandbox
 * id: the attempt must move with each box, whichever path provisions it (a
 * wake, a Restart, a retry after a failed wake).
 */
async function nextBoxGeneration(sessionId: string): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE kortix.project_sessions
       SET metadata = coalesce(metadata, '{}'::jsonb)
         || jsonb_build_object('ephemeral_generation', coalesce((metadata->>'ephemeral_generation')::int, 0) + 1)
     WHERE session_id = ${sessionId}
     RETURNING (metadata->>'ephemeral_generation')::int AS generation
  `)) as unknown as Array<{ generation: number }>;
  return Number(rows?.[0]?.generation ?? 1);
}

/**
 * Does a stop of this box delete it? Platinum session boxes only (meta and pi
 * worker boxes carry no session state), when the box mounted a session volume
 * or its project has the flag on (a box from before the flag migrates first).
 */
export async function retireOnStopPlan(sandboxId: string): Promise<{ metadata: unknown; sessionId: string } | null> {
  const [row] = await db
    .select({
      projectId: sessionSandboxes.projectId,
      sessionId: sessionSandboxes.sessionId,
      provider: sessionSandboxes.provider,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sandboxId))
    .limit(1);
  if (!row || row.provider !== 'platinum') return null;
  const md = (row.metadata ?? {}) as Record<string, unknown>;
  const artifact = md.runtimeArtifact as { runtimeProfile?: string } | undefined;
  if (artifact?.runtimeProfile && artifact.runtimeProfile !== 'standard') return null;
  if (recordedSessionStateVolume(md)) return { metadata: md, sessionId: row.sessionId };
  if (!(await ephemeralSandboxesEnabled(row.projectId, row.provider))) return null;
  return { metadata: md, sessionId: row.sessionId };
}

/** Deterministic, so every retry, wake and control plane names the same volume. */
export function sessionStateVolumeName(sessionId: string): string {
  return `kss-${sessionId}`;
}

export function recordedSessionStateVolume(metadata: unknown): string | null {
  const v = (metadata as Record<string, unknown> | null | undefined)?.[SESSION_STATE_VOLUME_KEY];
  return typeof v === 'string' && v ? v : null;
}

export function isRetiredEphemeralRow(row: {
  status: string;
  externalId: string | null;
  metadata: unknown;
}): boolean {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  return row.status === 'stopped' && !row.externalId && typeof m[EPHEMERAL_RETIRED_KEY] === 'string';
}

// ─── Platinum calls ────────────────────────────────────────────────────────

/** The connection itself failed (a reset, a refused connect): the request may be sent again. */
function isConnectionFailure(err: unknown): boolean {
  if (err instanceof EphemeralStorageError) return false;
  const e = err as { code?: string; name?: string; message?: string } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return false;
  return /ECONNRESET|ECONNREFUSED|ConnectionRefused|socket connection was closed|Unable to connect/i.test(
    `${e?.code ?? ''} ${e?.message ?? ''}`,
  );
}

/**
 * Every call here is safe to repeat (reads, open-or-create, commit, delete, a
 * read-only check), so a dropped connection is retried twice before it fails
 * a stop or a wake.
 */
async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await platinumFetch(path, {
        ...rest,
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      break;
    } catch (err) {
      if (attempt >= 3 || !isConnectionFailure(err)) throw err;
      console.warn(`[ephemeral] ${init.method ?? 'GET'} ${path}: connection failed (try ${attempt}), retrying`);
      await Bun.sleep(attempt * 2_000);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new EphemeralStorageError(res.status, `platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return res;
}

export class EphemeralStorageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EphemeralStorageError';
  }
}

/** Open-or-create. Idempotent by name. */
export async function ensureSessionStateVolume(sessionId: string): Promise<string> {
  const name = sessionStateVolumeName(sessionId);
  try {
    await call(`/v1/volumes/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ sync_mode: 'git' }),
      timeoutMs: 15_000,
    });
  } catch (err) {
    // One volume per session: a workspace at its volume cap cannot start a new
    // ephemeral session. Say so instead of blaming the sandbox provider.
    if (err instanceof EphemeralStorageError && err.status === 403 && /quota_exceeded/.test(err.message)) {
      throw new Error(
        '[drives] This session’s storage could not be created: the workspace reached its storage volume limit. Delete old sessions or drives, or ask Kortix for more.',
      );
    }
    throw err;
  }
  return name;
}

interface VolumeMountRow {
  id: string;
  sandbox_id: string;
  state: string;
  mount_path: string;
}

export async function liveVolumeMounts(volume: string): Promise<VolumeMountRow[]> {
  const res = await call(`/v1/volumes/${encodeURIComponent(volume)}/mounts`, { timeoutMs: 10_000 });
  const body = (await res.json()) as { mounts?: VolumeMountRow[] };
  return body.mounts ?? [];
}

/** Mount states that still hold, or may still write, data the volume head does not have. */
const HOLDING_STATES = new Set(['pending', 'mounted', 'pulling', 'unmounting', 'unflushed']);

/**
 * Wait until no OTHER sandbox holds the volume with data the head may not have
 * yet: a previous box's final commit must land before a new box mounts the
 * head, or the new box starts from stale files. `exceptSandboxId` skips a box
 * that is allowed to keep it. Returns the holders still there at the deadline.
 */
export async function awaitVolumeReleased(
  volume: string,
  timeoutMs: number,
  exceptSandboxId?: string,
): Promise<VolumeMountRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holders = (await liveVolumeMounts(volume)).filter(
      (m) => HOLDING_STATES.has(m.state) && m.sandbox_id !== exceptSandboxId,
    );
    if (holders.length === 0 || Date.now() >= deadline) return holders;
    await Bun.sleep(500);
  }
}

/** Commit the box's session volume (guest freeze, so the snapshot is consistent). */
export async function commitSessionState(externalId: string): Promise<{ commitId: string | null; ms: number }> {
  const t0 = Date.now();
  const res = await call(
    `/v1/sandboxes/${encodeURIComponent(externalId)}/volumes/${encodeURIComponent(SESSION_STATE_MOUNT)}/commit`,
    { method: 'POST', body: '{}', timeoutMs: 180_000 },
  );
  const body = (await res.json().catch(() => ({}))) as { commit_id?: string; id?: string };
  return { commitId: body.commit_id ?? body.id ?? null, ms: Date.now() - t0 };
}

async function sandboxMountedSessionState(externalId: string): Promise<boolean> {
  try {
    const res = await call(`/v1/sandboxes/${encodeURIComponent(externalId)}/volumes`, { timeoutMs: 10_000 });
    const body = (await res.json()) as { mounts?: VolumeMountRow[] } | VolumeMountRow[];
    const mounts = Array.isArray(body) ? body : (body.mounts ?? []);
    return mounts.some((m) => m.mount_path === SESSION_STATE_MOUNT && HOLDING_STATES.has(m.state));
  } catch {
    return false;
  }
}

async function exec(externalId: string, script: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  const res = await call(`/v1/sandboxes/${encodeURIComponent(externalId)}/exec`, {
    method: 'POST',
    body: JSON.stringify({ cmd: ['bash', '-lc', script], timeout_ms: timeoutMs }),
    timeoutMs: timeoutMs + 30_000,
  });
  const body = (await res.json()) as { result?: { exit_code?: number; stdout?: string; stderr?: string; error?: string } };
  const r = body.result ?? {};
  return { code: typeof r.exit_code === 'number' ? r.exit_code : -1, out: `${r.stdout ?? ''}${r.stderr ?? r.error ?? ''}` };
}

/**
 * A box that booted before the flag was on: attach the session volume to it and
 * copy its state across, in the layout the entrypoint binds from. Runs once, at
 * the box's first stop under the flag; the box is still running.
 */
export async function migrateBoxStateToVolume(externalId: string, sessionId: string): Promise<{ ms: number; bytes: number }> {
  const t0 = Date.now();
  const volume = await ensureSessionStateVolume(sessionId);
  const held = await awaitVolumeReleased(volume, 30_000, externalId);
  if (held.length) throw new Error(`session volume ${volume} is still held by ${held.map((h) => h.sandbox_id).join(',')}`);
  if (!(await sandboxMountedSessionState(externalId))) {
    const res = await call(
      `/v1/sandboxes/${encodeURIComponent(externalId)}/volumes/${encodeURIComponent(SESSION_STATE_MOUNT)}`,
      { method: 'POST', body: JSON.stringify({ volume }), timeoutMs: 120_000 },
    );
    if (res.status === 202) {
      // Accepted, still attaching: wait for the guest to report it mounted.
      const deadline = Date.now() + 90_000;
      while (!(await sandboxMountedSessionState(externalId))) {
        if (Date.now() > deadline) throw new Error('session volume attach did not finish');
        await Bun.sleep(500);
      }
    }
  }
  const root = SESSION_STATE_MOUNT;
  const copies = SESSION_STATE_DIRS.map(
    ([name, src]) =>
      `if [ -d ${src} ] && [ ! -d ${root}/${name} ]; then mkdir -p ${root}/${name}.seed && cp -a ${src}/. ${root}/${name}.seed/ && mv ${root}/${name}.seed ${root}/${name}; fi`,
  ).join('\n');
  const script = [
    'set -eu',
    `mountpoint -q ${root}`,
    'sync',
    copies,
    `chown -R kortix:kortix ${root}`,
    `rm -f ${root}/opencode-data/auth.json`,
    `du -sb ${root} | cut -f1`,
  ].join('\n');
  const r = await exec(externalId, `sudo -n bash -c ${shellQuote(script)}`, 300_000);
  if (r.code !== 0) throw new Error(`migrating session state failed (exit ${r.code}): ${r.out.slice(-400)}`);
  const bytes = Number(r.out.trim().split('\n').pop() ?? 0) || 0;
  return { ms: Date.now() - t0, bytes };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Stop an ephemeral box: commit its session volume, delete the box, wait for
 * the volume to be released (the delete's own final commit). Throws on a
 * failed commit so the caller leaves the row active and a later pass retries:
 * deleting a box whose state is not on the volume would lose it.
 */
export class EphemeralRetireError extends Error {
  constructor(
    readonly phase: 'migrate' | 'commit' | 'delete',
    message: string,
  ) {
    super(message);
    this.name = 'EphemeralRetireError';
  }
}

async function providerState(externalId: string): Promise<string> {
  try {
    const res = await call(`/v1/sandboxes/${encodeURIComponent(externalId)}`, { timeoutMs: 10_000 });
    const body = (await res.json()) as { state?: string };
    return String(body.state ?? 'unknown').toLowerCase();
  } catch (err) {
    if (err instanceof EphemeralStorageError && err.status === 404) return 'deleted';
    return 'unknown';
  }
}

export interface RetireTimings {
  migrated: boolean;
  migrateMs: number;
  commitMs: number;
  deleteMs: number;
  releaseMs: number;
  totalMs: number;
  providerStateBefore: string;
}

/**
 * Stop an ephemeral box: commit its session volume, delete the box, wait for
 * the volume to be released (the delete runs its own final commit too).
 *
 * Failure before the delete (`migrate`, `commit`) leaves the box as it was; the
 * caller may fall back to a plain stop, whose own final commit keeps the
 * volume current. A failed delete (`delete`) must be retried as a delete.
 */
export async function retireEphemeralBox(input: {
  externalId: string;
  sessionId: string;
  metadata: unknown;
}): Promise<RetireTimings> {
  const { externalId, sessionId } = input;
  const t0 = Date.now();
  const before = await providerState(externalId);
  let migrated = false;
  let migrateMs = 0;
  let commitMs = 0;
  if (before === 'running') {
    if (!recordedSessionStateVolume(input.metadata) && !(await sandboxMountedSessionState(externalId))) {
      try {
        const m = await migrateBoxStateToVolume(externalId, sessionId);
        await recordSessionStateVolume(sessionId, sessionStateVolumeName(sessionId));
        migrated = true;
        migrateMs = m.ms;
        console.info(`[ephemeral] migrated session ${sessionId} state onto its volume (${m.bytes} bytes, ${m.ms}ms)`);
      } catch (err) {
        throw new EphemeralRetireError('migrate', err instanceof Error ? err.message : String(err));
      }
    }
    try {
      commitMs = (await commitSessionState(externalId)).ms;
    } catch (err) {
      throw new EphemeralRetireError('commit', err instanceof Error ? err.message : String(err));
    }
  } else if (before !== 'deleted' && before !== 'stopped' && !before.includes('archiv')) {
    // starting, stopping, unknown: nothing safe to commit against yet.
    throw new EphemeralRetireError('commit', `box ${externalId} is ${before}; not retiring now`);
  }
  const t1 = Date.now();
  if (before !== 'deleted') {
    try {
      await call(`/v1/sandboxes/${encodeURIComponent(externalId)}`, { method: 'DELETE', timeoutMs: 60_000 });
    } catch (err) {
      if (!(err instanceof EphemeralStorageError && err.status === 404)) {
        throw new EphemeralRetireError('delete', err instanceof Error ? err.message : String(err));
      }
    }
  }
  const deleteMs = Date.now() - t1;
  // Not awaited: the commit above already made the state durable, and the
  // delete's own final commit (nothing new, the turn was aborted first) lands
  // on the host's schedule. A wake that comes sooner waits for it
  // (resolveSessionStateMount), so a stop never holds the user for it.
  const volume = sessionStateVolumeName(sessionId);
  const t2 = Date.now();
  void awaitVolumeReleased(volume, 120_000)
    .then((held) => {
      const ms = Date.now() - t2;
      if (held.length) {
        console.warn(`[ephemeral] ${volume} still held ${ms}ms after delete: ${held.map((h) => `${h.sandbox_id}:${h.state}`).join(',')}`);
      } else {
        console.info(`[ephemeral] ${volume} released ${ms}ms after delete`);
      }
    })
    .catch(() => {});
  return {
    migrated,
    migrateMs,
    commitMs,
    deleteMs,
    releaseMs: 0,
    totalMs: Date.now() - t0,
    providerStateBefore: before,
  };
}

/**
 * The wake of a retired row: drop it (it has no external id, so the identity
 * guard allows it) so the normal allocation path inserts a fresh one. Atomic:
 * of two concurrent opens exactly one wins the delete and allocates.
 */
export async function claimRetiredEphemeralRow(
  sandboxId: string,
): Promise<{ nextCreateAttempt: number } | null> {
  const deleted = await db
    .delete(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        isNull(sessionSandboxes.externalId),
        eq(sessionSandboxes.status, 'stopped'),
        sql`${sessionSandboxes.metadata} ? ${EPHEMERAL_RETIRED_KEY}`,
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId, metadata: sessionSandboxes.metadata });
  if (deleted.length === 0) return null;
  await endComputeSession(sandboxId).catch((err) =>
    console.warn(`[ephemeral] closing compute for retired ${sandboxId} failed:`, err),
  );
  // Platinum's create dedup keys on (sandbox id, template, attempt): the new
  // box is a new attempt, or its create would replay (or collide with) the
  // retired box's.
  const prev = Number((deleted[0]!.metadata as Record<string, unknown> | null)?.platinumCreateAttempt);
  return { nextCreateAttempt: (Number.isFinite(prev) && prev > 0 ? prev : 1) + 1 };
}

/**
 * A deleted session's state volume goes with it, once the box that mounts it
 * is gone (the delete of the box is asynchronous). Detached and best effort:
 * a volume left behind is storage, never a correctness problem.
 */
export function scheduleSessionStateVolumeDelete(sessionId: string): void {
  void (async () => {
    const volume = await sessionStateVolumeOf(sessionId);
    if (!volume) return;
    // Durable: the drive worker retries while the removed box still holds it.
    const { queueVolumeDeletion } = await import('../../drives/workers');
    await queueVolumeDeletion(volume, 'session_deleted', 20_000);
  })().catch((err) => console.warn(`[ephemeral] queueing the state volume of ${sessionId} for deletion failed:`, err));
}

/**
 * The box could not mount the session volume because its head is unreadable
 * (the guest refuses the filesystem: a commit torn by a host failure). Restore
 * the volume to the commit before the head and report it; null when the mount
 * failed for any other reason, or there is no earlier commit.
 */
export async function rollBackUnmountableSessionState(
  externalId: string,
  volume: string,
): Promise<{ to: string; error: string } | null> {
  const mounts = await liveVolumeMounts(volume).catch(() => [] as VolumeMountRow[]);
  const ours = mounts.find((m) => m.sandbox_id === externalId) as (VolumeMountRow & { error?: string | null }) | undefined;
  const error = ours?.error ?? '';
  if (!/mount_failed|bad message|structure needs cleaning|bad superblock|corrupt/i.test(error)) return null;
  const res = await call(`/v1/volumes/${encodeURIComponent(volume)}/commits?limit=2`, { timeoutMs: 10_000 });
  const commits = ((await res.json()) as { commits?: Array<{ id: string }> }).commits ?? [];
  const previous = commits[1];
  if (!previous) return null;
  await call(`/v1/volumes/${encodeURIComponent(volume)}/restore`, {
    method: 'POST',
    body: JSON.stringify({ to: previous.id }),
    timeoutMs: 30_000,
  });
  return { to: previous.id, error: error.slice(0, 200) };
}

/** The booted image predates session-state support: its entrypoint ignores the volume. */
export class SessionStateUnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateUnsupportedImageError';
  }
}

/**
 * Prove a new box keeps the session's state on its volume before the session
 * uses it: the image's entrypoint must know KORTIX_PERSIST_ROOT (an image built
 * before it existed would run the session on the image disk, and the delete at
 * stop would take the work with it), and /workspace must be the volume's
 * filesystem. Waits for the bind, which lands a moment after boot.
 */
export async function verifySessionStateBound(externalId: string, timeoutMs = 90_000): Promise<number> {
  const t0 = Date.now();
  const script = [
    `grep -q ${SESSION_STATE_ENV} /usr/local/bin/kortix-entrypoint || { echo unsupported; exit 0; }`,
    `end=$(( $(date +%s) + ${Math.ceil(timeoutMs / 1000)} ))`,
    'while [ "$(date +%s)" -lt "$end" ]; do',
    `  if mountpoint -q ${SESSION_STATE_MOUNT} && [ "$(stat -c %d /workspace)" = "$(stat -c %d ${SESSION_STATE_MOUNT})" ] \\`,
    `     && [ "$(stat -c %d /home/kortix/.local/share/opencode)" = "$(stat -c %d ${SESSION_STATE_MOUNT})" ]; then echo bound; exit 0; fi`,
    '  sleep 0.2',
    'done',
    'echo timeout',
  ].join('\n');
  const r = await exec(externalId, script, timeoutMs + 15_000);
  const verdict = r.out.trim().split('\n').pop();
  if (verdict === 'bound') return Date.now() - t0;
  if (verdict === 'unsupported') {
    throw new SessionStateUnsupportedImageError(`box ${externalId} runs an image without session-state support`);
  }
  throw new Error(`session state was not bound in box ${externalId} (${verdict ?? r.out.slice(-200)})`);
}
