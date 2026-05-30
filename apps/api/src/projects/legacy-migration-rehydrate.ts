/**
 * Restore a migrated session's chat history into its freshly-booted sandbox.
 *
 * Migrated sessions boot a clean OpenCode store, so the original conversation
 * (stored in the legacy machine's opencode.db) isn't there. This pulls the
 * legacy opencode store from the (still-running) legacy VM and writes it into
 * the new sandbox's OpenCode store, then bounces opencode so it serves the
 * original sessions — the project_session's opencode_session_id then resolves to
 * the real transcript.
 *
 * Transfer is VM -> backend -> new sandbox (Daytona SDK); no external storage
 * needed. In production the source would be the durable backup bundle instead of
 * the live VM.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { legacySandboxMigrations, sandboxes, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { getDaytona } from '../shared/daytona';
import { logger as appLogger } from '../lib/logger';
import { RESOLVE_WS_OC_SH, execOnLegacyVm, resolveLegacyVmEndpoint } from './legacy-vm-access';

// Where the NEW sandbox's OpenCode keeps its store (OPENCODE_HOME in the
// sandbox agent server = /opt/kortix/home).
const NEW_OPENCODE_STORE = '/opt/kortix/home/.local/share/opencode';

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RehydrateInput {
  sessionId: string;
  legacySandboxId: string;
  /** New sandbox's provider external id; looked up from session_sandboxes if omitted. */
  newExternalId?: string;
}

export async function rehydrateSessionChat(input: RehydrateInput): Promise<void> {
  const { sessionId, legacySandboxId } = input;

  // 1. Resolve the new sandbox — wait for it to finish booting (provisioning is
  //    async). Up to ~4 min for a first-time build.
  let externalId = input.newExternalId ?? null;
  if (!externalId) {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const [row] = await db
        .select({ status: sessionSandboxes.status, ext: sessionSandboxes.externalId })
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sessionId, sessionId))
        .limit(1);
      if (row?.status === 'active' && row.ext) { externalId = row.ext; break; }
      if (row?.status === 'error') {
        appLogger.warn('[rehydrate] new sandbox errored, skipping', { sessionId });
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!externalId) {
      appLogger.warn('[rehydrate] new sandbox did not become active in time', { sessionId });
      return;
    }
  }

  // 2. Pull the legacy OpenCode store (opencode.db + WAL) from the legacy VM.
  // Prefer the archive captured at migration time (self-contained: no live VM,
  // no JustAVPS key). Fall back to pulling from the live VM only if it's absent.
  let b64: string | null = null;
  const [mig] = await db
    .select({ archive: legacySandboxMigrations.opencodeArchive })
    .from(legacySandboxMigrations)
    .where(and(
      eq(legacySandboxMigrations.sandboxId, legacySandboxId),
      isNotNull(legacySandboxMigrations.opencodeArchive),
    ))
    .limit(1);
  if (mig?.archive) {
    b64 = mig.archive;
    appLogger.info('[rehydrate] using archived opencode store from DB', { sessionId, legacySandboxId });
  } else {
    const [legacy] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, legacySandboxId)).limit(1);
    if (!legacy) {
      appLogger.warn('[rehydrate] no archive and legacy sandbox row missing', { legacySandboxId });
      return;
    }
    const endpoint = await resolveLegacyVmEndpoint(legacy);
    const pullScript = [
      RESOLVE_WS_OC_SH,
      '[ -z "$OC" ] && exit 0',
      'cd "$OC" && tar czf - opencode.db opencode.db-wal opencode.db-shm 2>/dev/null | base64 | tr -d "\\n"',
    ].join('\n');
    const pulled = await execOnLegacyVm(endpoint, `bash -c ${sq(pullScript)}`, 180);
    b64 = pulled.stdout.trim() || null;
  }
  if (!b64) {
    appLogger.warn('[rehydrate] legacy opencode store empty / not found', { legacySandboxId });
    return;
  }

  const sandbox = await getDaytona().get(externalId);

  // 3. Determine the NEW workspace's opencode projectID. OpenCode scopes its
  //    session list by projectID (a hash of the workspace's git identity), and
  //    the Freestyle-cloned workspace hashes differently than the legacy machine
  //    did. Without re-keying, the restored sessions exist but are invisible to
  //    the current project. Read it from opencode's own session list.
  // POST (create) a session for the workspace — its projectID IS the current
  // project's id. GET /session can't be used: after a prior restore it returns
  // only legacy-projectID sessions (filtered out), or nothing. The throwaway
  // session is discarded when we overwrite the db below.
  const sessRes = await sandbox.process.executeCommand(
    "cd /opt/kortix/home 2>/dev/null; PORT=$(cat /var/run/kortix/opencode-port 2>/dev/null || echo 4096); curl -s -X POST \"http://127.0.0.1:$PORT/session?directory=/workspace\" 2>/dev/null",
    undefined, undefined, 30,
  );
  const sessOut = (sessRes as { result?: string; artifacts?: { stdout?: string } }).result
    ?? (sessRes as { artifacts?: { stdout?: string } }).artifacts?.stdout ?? '';
  // The sandbox's cwd can be deleted (getcwd errors leak onto stdout) — extract
  // the JSON object rather than parsing the whole blob.
  let newProjectId: string | null = null;
  const jsonStart = sessOut.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const obj = JSON.parse(sessOut.slice(jsonStart)) as { projectID?: string };
      newProjectId = obj.projectID ?? null;
    } catch { /* fall through */ }
  }
  appLogger.info('[rehydrate] resolved new projectID', { sessionId, newProjectId, raw: sessOut.slice(0, 120) });
  if (!newProjectId) {
    appLogger.warn('[rehydrate] could not read new opencode projectID; sessions may not surface', { sessionId });
  }

  // 4. Rewrite the legacy store locally: point every session at the new
  //    projectID and checkpoint the WAL into the db so we can ship a single
  //    self-contained file.
  const workDir = mkdtempSync(join(tmpdir(), 'kortix-rehydrate-'));
  let dbBuf: Buffer;
  try {
    writeFileSync(join(workDir, 'oc.tar.gz'), Buffer.from(b64, 'base64'));
    const untar = Bun.spawnSync(['tar', 'xzf', join(workDir, 'oc.tar.gz'), '-C', workDir]);
    if (untar.exitCode !== 0) throw new Error(`unpack failed: ${new TextDecoder().decode(untar.stderr)}`);
    const local = new Database(join(workDir, 'opencode.db'));
    try {
      if (newProjectId) {
        local.exec('PRAGMA foreign_keys=OFF');
        local.prepare('UPDATE project SET id = ?').run(newProjectId);
        local.prepare('UPDATE session SET project_id = ?').run(newProjectId);
      }
      local.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      local.close();
    }
    dbBuf = readFileSync(join(workDir, 'opencode.db'));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  // 5. Ship the rewritten db; drop the stale WAL/shm so opencode reads ours;
  //    bounce opencode (supervisor respawns `opencode serve`; daemon is separate).
  await sandbox.fs.uploadFile(dbBuf, '/tmp/opencode.db');
  const restore = [
    `mkdir -p ${NEW_OPENCODE_STORE}`,
    `rm -f ${NEW_OPENCODE_STORE}/opencode.db-wal ${NEW_OPENCODE_STORE}/opencode.db-shm`,
    `mv /tmp/opencode.db ${NEW_OPENCODE_STORE}/opencode.db`,
    `chown -R --reference=/opt/kortix/home ${NEW_OPENCODE_STORE} 2>/dev/null || true`,
    "pkill -f 'opencode serve' || true",
  ].join('; ');
  await sandbox.process.executeCommand(restore, undefined, undefined, 120);

  appLogger.info('[rehydrate] restored opencode store + re-keyed projectID + bounced opencode', {
    sessionId,
    externalId,
    newProjectId,
    bytes: dbBuf.length,
  });
}
