/**
 * Restore a migrated session's chat into its sandbox DURING provisioning, before
 * the sandbox is marked active.
 *
 * Why before-active: the frontend, once it sees `active`, calls `ensure-opencode`
 * (opencode-mapping.ts) — the authoritative writer of opencode_session_id. It
 * lists the sandbox's opencode sessions and keeps the migrated pin only if that
 * session is already present; otherwise it re-pins to a fresh session. So the
 * legacy store must be loaded before `active`, or we lose the race and the chat.
 *
 * Source is the live legacy VM (durable JustAVPS host) — we pull its opencode
 * store, re-key project_id to this workspace's opencode projectID (opencode
 * scopes its session list by project), ship a single checkpointed db, and bounce
 * opencode so it serves the original conversations.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { legacySandboxMigrations, sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { getDaytona } from '../shared/daytona';
import { logger as appLogger } from '../lib/logger';
import { RESOLVE_WS_OC_SH, execOnLegacyVm, resolveLegacyVmEndpoint } from './legacy-vm-access';

const NEW_OPENCODE_STORE = '/opt/kortix/home/.local/share/opencode';

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type DaytonaSandbox = Awaited<ReturnType<ReturnType<typeof getDaytona>['get']>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a session for the workspace and return its projectID — doubles as an
 * opencode-readiness probe (succeeds only once opencode is serving). The
 * throwaway session is discarded when we overwrite the db.
 */
async function waitForOpencodeProjectId(sandbox: DaytonaSandbox, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await sandbox.process.executeCommand(
        'cd /opt/kortix/home 2>/dev/null; P=$(cat /var/run/kortix/opencode-port 2>/dev/null || echo 4096); ' +
          'curl -s -X POST "http://127.0.0.1:$P/session?directory=/workspace" 2>/dev/null',
        undefined, undefined, 30,
      );
      const out = (res as { result?: string }).result ?? '';
      const start = out.indexOf('{');
      if (start >= 0) {
        const obj = JSON.parse(out.slice(start)) as { projectID?: string };
        if (obj.projectID) return obj.projectID;
      }
    } catch { /* opencode not up yet */ }
    await sleep(3000);
  }
  return null;
}

export interface RehydrateInput {
  sessionId: string;
  legacySandboxId: string;
  newExternalId: string;
}

export async function rehydrateSessionChat(input: RehydrateInput): Promise<void> {
  const { sessionId, legacySandboxId, newExternalId } = input;
  const sandbox = await getDaytona().get(newExternalId);

  // 1. Wait for opencode to be serving + learn this workspace's projectID.
  const newProjectId = await waitForOpencodeProjectId(sandbox, 180_000);
  if (!newProjectId) {
    appLogger.warn('[rehydrate] opencode never became ready; skipping', { sessionId, newExternalId });
    return;
  }

  // 2. Get the legacy OpenCode store. Prefer the archive captured at migration
  //    time (no live JustAVPS key needed — those keys expire). Fall back to a
  //    live VM pull only if the migration never captured one.
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
    appLogger.info('[rehydrate] using chat store captured at migration', { sessionId, legacySandboxId });
  } else {
    const [legacy] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, legacySandboxId)).limit(1);
    if (!legacy) {
      appLogger.warn('[rehydrate] no captured archive and legacy sandbox row missing', { legacySandboxId });
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

  // 3. Locally re-key every session to this workspace's projectID and checkpoint
  //    the WAL into the db so we ship one self-contained file.
  const workDir = mkdtempSync(join(tmpdir(), 'kortix-rehydrate-'));
  let dbBuf: Buffer;
  try {
    writeFileSync(join(workDir, 'oc.tar.gz'), Buffer.from(b64, 'base64'));
    const untar = Bun.spawnSync(['tar', 'xzf', join(workDir, 'oc.tar.gz'), '-C', workDir]);
    if (untar.exitCode !== 0) throw new Error(`unpack failed: ${new TextDecoder().decode(untar.stderr)}`);
    const local = new Database(join(workDir, 'opencode.db'));
    try {
      local.exec('PRAGMA foreign_keys=OFF');
      local.prepare('UPDATE project SET id = ?').run(newProjectId);
      local.prepare('UPDATE session SET project_id = ?').run(newProjectId);
      local.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      local.close();
    }
    dbBuf = readFileSync(join(workDir, 'opencode.db'));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  // 4. Ship the db, drop stale WAL/shm, bounce opencode (supervisor respawns
  //    `opencode serve`; the daemon is a separate process).
  await sandbox.fs.uploadFile(dbBuf, '/tmp/opencode.db');
  await sandbox.process.executeCommand(
    [
      `mkdir -p ${NEW_OPENCODE_STORE}`,
      `rm -f ${NEW_OPENCODE_STORE}/opencode.db-wal ${NEW_OPENCODE_STORE}/opencode.db-shm`,
      `mv /tmp/opencode.db ${NEW_OPENCODE_STORE}/opencode.db`,
      `chown -R --reference=/opt/kortix/home ${NEW_OPENCODE_STORE} 2>/dev/null || true`,
      "pkill -f 'opencode serve' || true",
    ].join('; '),
    undefined, undefined, 120,
  );

  // 5. Wait for opencode to come back up so it's serving the restored sessions
  //    before we let the caller mark the sandbox active.
  await waitForOpencodeProjectId(sandbox, 120_000);

  appLogger.info('[rehydrate] restored legacy chats before active', {
    sessionId, newExternalId, newProjectId, bytes: dbBuf.length,
  });
}
