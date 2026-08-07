/**
 * Restore a migrated session's chat into its sandbox DURING provisioning, before
 * the sandbox is marked active — re-land of the module removed in 0d8c2cbe97
 * (#4592). Suna-account migrations (suna-migration-phases.ts) still write the
 * `legacy_migration` metadata + upload the opencode archive this module ships;
 * without it every migrated session opens with an empty chat.
 *
 * Why before-active: the frontend, once it sees `active`, calls `ensure-opencode`
 * (opencode-mapping.ts) — the authoritative writer of opencode_session_id. It
 * keeps the migrated pin only if that session already exists in the sandbox's
 * opencode store; otherwise it re-pins to a fresh session. The hook therefore
 * runs through `beforeActive` (session-sandbox.ts), and additionally restores
 * the pin at the end so a lost race self-heals on the next open.
 *
 * Mechanics proven live on prod (project 79d76143, sandbox d265e212):
 * download the archive captured at migration time, re-key its project ids to the
 * workspace's opencode projectID (opencode scopes session lists by project),
 * SIGKILL the server (pattern must match `opencode.exe serve`), swap the db in,
 * and let the supervisor respawn onto it.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger as appLogger } from '../lib/logger';
import { getDaytona } from '../shared/daytona';
import { db } from '../shared/db';
import { downloadOpencodeArchive } from './legacy-migration-storage';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LegacyRehydrateSpec {
  sourceSandboxId: string;
  opencodeSessionId: string | null;
}

/**
 * Decide whether a session being provisioned needs a chat rehydrate.
 * `source_sandbox_id` comes from the session's own `legacy_migration` metadata,
 * falling back to the project's (both are written by the migration db phase).
 */
export function legacyRehydrateSpec(
  sessionMetadata: Record<string, unknown> | null | undefined,
  projectMetadata: Record<string, unknown> | null | undefined,
): LegacyRehydrateSpec | null {
  const fromSession = asObject(asObject(sessionMetadata).legacy_migration);
  const fromProject = asObject(asObject(projectMetadata).legacy_migration);
  const sourceSandboxId = firstString(fromSession.source_sandbox_id, fromProject.source_sandbox_id);
  if (!sourceSandboxId) return null;
  const opencodeSessionId = firstString(asObject(fromSession.rehydrate).opencode_session_id);
  return { sourceSandboxId, opencodeSessionId: opencodeSessionId ?? null };
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

/** Re-key every project/session row to the live workspace's opencode projectID
 *  and checkpoint the WAL so one self-contained file ships. */
export function rekeyOpencodeDb(dbPath: string, newProjectId: string): { sessions: number } {
  const local = new Database(dbPath);
  try {
    local.exec('PRAGMA foreign_keys=OFF');
    local.prepare('UPDATE project SET id = ?').run(newProjectId);
    local.prepare('UPDATE session SET project_id = ?').run(newProjectId);
    local.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const row = local.query('SELECT count(*) c FROM session').get() as { c: number };
    return { sessions: row.c };
  } finally {
    local.close();
  }
}

/** The current snapshot serves opencode as user `kortix` (HOME=/home/kortix);
 *  older snapshots used /opt/kortix/home. Resolve at runtime inside the box. */
const RESOLVE_STORE_SH =
  'if [ -d /home/kortix ]; then DEST=/home/kortix/.local/share/opencode; OWNER=/home/kortix; ' +
  'else DEST=/opt/kortix/home/.local/share/opencode; OWNER=/opt/kortix/home; fi';

export function buildRestoreScript(): string {
  return [
    RESOLVE_STORE_SH,
    'PORT=$(cat /var/run/kortix/opencode-port 2>/dev/null || echo 4096)',
    'mkdir -p "$DEST"',
    'cnt=0',
    'for i in $(seq 1 8); do',
    // The binary's argv[0] is `opencode.exe`, so the pattern must not assume a
    // bare `opencode` token — 'opencode serve' silently matches nothing.
    "  pkill -9 -f 'opencode[^ ]* serve' 2>/dev/null || true",
    '  sleep 0.5',
    '  rm -f "$DEST"/opencode.db-wal "$DEST"/opencode.db-shm "$DEST"/opencode.db',
    '  cp /tmp/opencode.db "$DEST"/opencode.db',
    '  chown -R --reference="$OWNER" "$DEST" 2>/dev/null || true',
    '  sleep 2.5',
    `  cnt=$(curl -s "http://127.0.0.1:$PORT/session?directory=/workspace" 2>/dev/null | grep -o '"id"' | wc -l)`,
    '  if [ "$cnt" -ge 10 ]; then echo "REHYDRATE_OK cnt=$cnt iter=$i"; rm -f /tmp/opencode.db; exit 0; fi',
    'done',
    'echo "REHYDRATE_INCOMPLETE last_cnt=$cnt"',
  ].join('\n');
}

export interface RehydrateInput {
  sessionId: string;
  externalId: string;
  provider: string;
  spec: LegacyRehydrateSpec;
}

export async function rehydrateSessionChat(input: RehydrateInput): Promise<void> {
  const { sessionId, externalId, spec } = input;
  if (input.provider !== 'daytona') {
    appLogger.warn('[rehydrate] provider not supported; skipping', {
      sessionId,
      provider: input.provider,
    });
    return;
  }
  const sandbox = await getDaytona().get(externalId);

  // 1. Wait for opencode to serve + learn this workspace's projectID. The
  //    throwaway session is discarded when the db is overwritten below.
  const newProjectId = await waitForOpencodeProjectId(sandbox, 180_000);
  if (!newProjectId) {
    appLogger.warn('[rehydrate] opencode never became ready; skipping', { sessionId, externalId });
    return;
  }

  // 2. The archive captured at migration time (object storage, keyed by the
  //    migration's source sandbox id — for suna migrations, the new projectId).
  const tarball = await downloadOpencodeArchive(spec.sourceSandboxId);
  if (!tarball) {
    appLogger.warn('[rehydrate] no opencode archive in storage', {
      sessionId,
      sourceSandboxId: spec.sourceSandboxId,
    });
    return;
  }

  // 3. Re-key locally and ship one checkpointed file.
  const workDir = mkdtempSync(join(tmpdir(), 'kortix-rehydrate-'));
  let dbBuf: Buffer;
  try {
    writeFileSync(join(workDir, 'oc.tar.gz'), tarball);
    const untar = Bun.spawnSync(['tar', 'xzf', join(workDir, 'oc.tar.gz'), '-C', workDir]);
    if (untar.exitCode !== 0)
      throw new Error(`unpack failed: ${new TextDecoder().decode(untar.stderr)}`);
    const dbName = existsSync(join(workDir, 'opencode.db'))
      ? 'opencode.db'
      : readdirSync(workDir).find((f) => f.endsWith('opencode.db'));
    if (!dbName)
      throw new Error(`no opencode.db in archive (got: ${readdirSync(workDir).join(', ')})`);
    const { sessions } = rekeyOpencodeDb(join(workDir, dbName), newProjectId);
    appLogger.info('[rehydrate] re-keyed archive', { sessionId, sessions, newProjectId });
    dbBuf = readFileSync(join(workDir, dbName));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  // 4. Replace opencode's db. Delicate: opencode holds the db open and flushes
  //    its WAL on SIGTERM, clobbering the write — so SIGKILL, replace after it
  //    is dead, let the supervisor respawn onto our file, and verify.
  await sandbox.fs.uploadFile(dbBuf, '/tmp/opencode.db');
  const restoreRes = await sandbox.process.executeCommand(
    buildRestoreScript(),
    undefined,
    undefined,
    120,
  );
  const restoreOut = ((restoreRes as { result?: string }).result ?? '').trim();
  appLogger.info('[rehydrate] restore finished', {
    sessionId,
    externalId,
    newProjectId,
    bytes: dbBuf.length,
    result: restoreOut.slice(-200),
  });

  // 5. Self-heal the pin. ensure-opencode may have re-pinned the row to a fresh
  //    session while the store was still empty (earlier open, or the bounded
  //    beforeActive wait elapsing); the migrated id in metadata is authoritative.
  if (spec.opencodeSessionId) {
    await db
      .update(projectSessions)
      .set({ opencodeSessionId: spec.opencodeSessionId, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, sessionId));
  }
}

type DaytonaSandbox = Awaited<ReturnType<ReturnType<typeof getDaytona>['get']>>;

/** Create a throwaway session for the workspace and return its projectID —
 *  doubles as an opencode-readiness probe. */
async function waitForOpencodeProjectId(
  sandbox: DaytonaSandbox,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await sandbox.process.executeCommand(
        'P=$(cat /var/run/kortix/opencode-port 2>/dev/null || echo 4096); ' +
          'curl -s -X POST "http://127.0.0.1:$P/session?directory=/workspace" 2>/dev/null',
        undefined,
        undefined,
        30,
      );
      const out = (res as { result?: string }).result ?? '';
      const start = out.indexOf('{');
      if (start >= 0) {
        const obj = JSON.parse(out.slice(start)) as { projectID?: string };
        if (obj.projectID) return obj.projectID;
      }
    } catch {
      /* opencode not up yet */
    }
    await sleep(3000);
  }
  return null;
}
