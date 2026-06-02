/**
 * Staged, manual end-to-end test for the lazy legacy migration against ONE real
 * JustAVPS machine, writing into the local database.
 *
 * Run stages in order — stage 1 is read-only and proves reachability + that the
 * VM shell scripts find the right paths BEFORE anything mutates state.
 *
 *   # 1. PROBE (read-only on the VM, writes nothing anywhere):
 *   bun run src/scripts/test-legacy-migration.ts --probe
 *
 *   # 2. SEED a kortix.sandboxes row in the LOCAL db describing the machine
 *   #    (skip if the row already exists locally):
 *   bun run src/scripts/test-legacy-migration.ts --seed
 *
 *   # 3. MIGRATE for real and poll to completion (mutates VM workspace, Supabase
 *   #    Storage, Freestyle, and the local db):
 *   bun run src/scripts/test-legacy-migration.ts --migrate
 *
 * Inputs (env):
 *   TEST_ACCOUNT_ID         local account to own the migrated project
 *   TEST_SANDBOX_ID         uuid for the local sandboxes row (any uuid; reused as session id)
 *   TEST_VM_BASE_URL        https base url of the machine, OR
 *   TEST_VM_SLUG            justavps slug (builds https://{slug}.{JUSTAVPS_PROXY_DOMAIN})
 *   TEST_VM_PROXY_TOKEN     X-Proxy-Token for the CF proxy (if required)
 *   TEST_VM_SERVICE_KEY     Authorization bearer for the toolbox (falls back to INTERNAL_SERVICE_KEY)
 * Plus the usual config: DATABASE_URL, SUPABASE_URL/SERVICE_ROLE_KEY, FREESTYLE_API_KEY,
 *   JUSTAVPS_PROXY_DOMAIN, LEGACY_MIGRATION_DEFAULT_IMAGE.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { legacySandboxMigrations, projectSessions, projects, sandboxes, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { resolveAccountId as resolveAccountForUser } from '../shared/resolve-account';
import { execOnLegacyVm, RESOLVE_WS_OC_SH, resolveLegacyVmEndpoint } from '../projects/legacy-vm-access';
import { ensureBackupBucket } from '../projects/legacy-migration-storage';
import { driveMigration, startMigration } from '../projects/legacy-migration-runner';
import { rehydrateSessionChat } from '../projects/legacy-migration-rehydrate';

/** Resolve the target account from TEST_ACCOUNT_ID, or TEST_ACCOUNT_EMAIL via auth.users. */
async function resolveTargetAccount(): Promise<string> {
  if (process.env.TEST_ACCOUNT_ID) return process.env.TEST_ACCOUNT_ID;
  const email = env('TEST_ACCOUNT_EMAIL');
  const rows = (await db.execute(
    sql`select id from auth.users where email = ${email} limit 1`,
  )) as unknown as Array<{ id: string }>;
  const userId = rows[0]?.id;
  if (!userId) throw new Error(`No auth.users row for ${email} in the local database`);
  const accountId = await resolveAccountForUser(userId);
  console.log(`Resolved ${email} -> user ${userId} -> account ${accountId}`);
  return accountId;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env ${name}`);
  return v;
}

// Build the legacy-sandbox-shaped object the helpers expect, from env.
function fakeLegacyRow() {
  return {
    sandboxId: env('TEST_SANDBOX_ID'),
    externalId: process.env.TEST_VM_EXTERNAL_ID ?? env('TEST_SANDBOX_ID'),
    baseUrl: process.env.TEST_VM_BASE_URL ?? null,
    config: { serviceKey: process.env.TEST_VM_SERVICE_KEY },
    metadata: {
      justavpsSlug: process.env.TEST_VM_SLUG,
      justavpsProxyToken: process.env.TEST_VM_PROXY_TOKEN,
    },
  };
}

async function probe() {
  const legacy = fakeLegacyRow();
  const endpoint = await resolveLegacyVmEndpoint(legacy as never);
  console.log('Resolved endpoint:', endpoint.url);
  console.log('Auth headers:', Object.keys(endpoint.headers).join(', '));

  // Exactly the path-resolution the extract/push scripts use — read-only.
  const inspect = [
    RESOLVE_WS_OC_SH,
    'echo "workspace=$WS"',
    'echo "opencode_store=$OC"',
    'echo "workspace_size=$(du -sh "$WS" 2>/dev/null | cut -f1)"',
    '[ -n "$OC" ] && echo "opencode_size=$(du -sh "$OC" 2>/dev/null | cut -f1)"',
    '[ -n "$OC" ] && [ -d "$OC/storage/message" ] && echo "session_count=$(ls -1 "$OC/storage/message" | wc -l)" || echo "session_count=0"',
    'echo "has_git=$([ -d "$WS/.git" ] && echo yes || echo no)"',
    'echo "has_kortix_toml=$([ -f "$WS/kortix.toml" ] && echo yes || echo no)"',
    'command -v curl >/dev/null && echo "curl=yes" || echo "curl=NO"',
    'command -v git >/dev/null && echo "git=yes" || echo "git=NO"',
    'command -v tar >/dev/null && echo "tar=yes" || echo "tar=NO"',
    // Deep hunt for the OpenCode store if the known paths missed it.
    'echo "--- env hints ---"',
    'env | grep -iE "OPENCODE|KORTIX_PERSISTENT|^HOME=" || true',
    'echo "--- workspace contents ---"',
    'ls -la "$WS" 2>/dev/null | head -40 || true',
    'echo "--- opencode.db anywhere (maxdepth 7) ---"',
    'timeout 30 find / -maxdepth 7 -name opencode.db 2>/dev/null | head -20 || true',
    'echo "--- storage/message dirs ---"',
    'timeout 30 find / -maxdepth 8 -type d -path "*storage/message" 2>/dev/null | head -20 || true',
    'echo "--- candidate roots ---"',
    'for d in /opt/kortix/home /root /persistent /home; do [ -d "$d" ] && echo "$d: $(ls -A "$d" 2>/dev/null | head -10 | tr "\\n" " ")"; done',
    'echo "--- opencode.db inspect ---"',
    'command -v sqlite3 >/dev/null && echo "sqlite3=yes" || echo "sqlite3=NO"',
    '[ -n "$OC" ] && [ -f "$OC/opencode.db" ] && command -v sqlite3 >/dev/null && echo "tables: $(sqlite3 "$OC/opencode.db" ".tables" 2>/dev/null | tr "\\n" " ")"',
    '[ -n "$OC" ] && command -v sqlite3 >/dev/null && for t in session sessions thread threads conversation messages; do c=$(sqlite3 "$OC/opencode.db" "select count(*) from $t" 2>/dev/null); [ -n "$c" ] && echo "rows.$t=$c"; done',
    '[ -n "$OC" ] && echo "--- store tree (2 levels) ---" && find "$OC" -maxdepth 2 2>/dev/null | head -40',
    'echo "--- ALL .db files (maxdepth 7) ---"',
    'timeout 30 find / -maxdepth 7 -name "*.db" 2>/dev/null | grep -vE "/proc/|/sys/" | head -40',
    'echo "--- home dirs ---"',
    'for h in /home/abc /home/user /root; do echo "[$h] size=$(du -sh "$h" 2>/dev/null|cut -f1)"; find "$h/.local/share" -maxdepth 3 2>/dev/null | head -20; done',
    'echo "--- /workspace/.kortix ---"',
    'ls -la /workspace/.kortix 2>/dev/null; find /workspace/.kortix -maxdepth 2 2>/dev/null | head -20',
    'echo "--- anything opencode/session named ---"',
    'timeout 25 find / -maxdepth 7 \\( -iname "*opencode*" -o -iname "*session*" \\) 2>/dev/null | grep -vE "/proc/|/sys/|/usr/|node_modules" | head -30',
    'echo "=== NESTED DOCKER VOLUME (real data) ==="',
    'VOL=/var/lib/docker/volumes/justavps-data/_data',
    'echo "[vol] size=$(du -sh "$VOL" 2>/dev/null|cut -f1)"; ls -la "$VOL" 2>/dev/null | head -40',
    'echo "--- opencode store in volume ---"',
    'find "$VOL" -maxdepth 4 \\( -iname "*opencode*" -o -name "*.db" \\) 2>/dev/null | head -40',
    'echo "--- sessions: storage/message dirs in volume ---"',
    'find "$VOL" -maxdepth 6 -type d -path "*storage/message" 2>/dev/null | head; for d in $(find "$VOL" -maxdepth 6 -type d -path "*storage/message" 2>/dev/null | head -3); do echo "  $d -> $(ls -1 "$d" 2>/dev/null | wc -l) sessions"; done',
  ].join('\n');

  const res = await execOnLegacyVm(endpoint, `bash -c '${inspect.replace(/'/g, `'\\''`)}'`, 60);
  console.log('\n--- VM probe result ---');
  console.log('exit:', res.exitCode);
  console.log(res.stdout || '(no stdout)');
  if (res.stderr) console.log('stderr:', res.stderr);
  if (!res.success) {
    console.error('\n❌ Probe failed — fix reachability/auth before migrating.');
    process.exit(1);
  }
  console.log('\n✅ Probe OK. Review paths/sizes/tools above before --seed/--migrate.');
}

async function seed() {
  const sandboxId = env('TEST_SANDBOX_ID');
  const accountId = await resolveTargetAccount();
  const legacy = fakeLegacyRow();
  await db.insert(sandboxes).values({
    sandboxId,
    accountId,
    name: process.env.TEST_VM_NAME ?? 'Test legacy machine',
    provider: 'justavps',
    externalId: legacy.externalId,
    // base_url is NOT NULL; when only a slug is given, resolveLegacyVmEndpoint
    // rebuilds the CF proxy URL from metadata.justavpsSlug at migrate time.
    baseUrl: legacy.baseUrl ?? '',
    status: 'active',
    config: legacy.config as Record<string, unknown>,
    metadata: legacy.metadata as Record<string, unknown>,
  }).onConflictDoNothing({ target: sandboxes.sandboxId });
  console.log(`✅ Seeded local sandboxes row ${sandboxId} for account ${accountId}`);
}

async function migrate() {
  const sandboxId = env('TEST_SANDBOX_ID');
  const accountId = await resolveTargetAccount();
  // autoDrive:false — we drive synchronously below so the script stays
  // foreground (background tasks have no network) and exits promptly.
  const { migration, created } = await startMigration({
    database: db,
    sandboxId,
    accountId,
    autoDrive: false,
  });
  console.log(`Migration ${created ? 'started' : 'already existed'}: ${migration.migrationId}`);

  // Drive in bounded passes. One driveMigration() walks ALL remaining phases
  // until completion or a phase error (which releases the lease); on error we
  // call again to retry from that phase, like the resume worker would.
  let full = migration;
  for (let pass = 0; pass < 8; pass++) {
    await driveMigration(db, migration.migrationId);
    [full] = await db.select().from(legacySandboxMigrations)
      .where(eq(legacySandboxMigrations.migrationId, migration.migrationId)).limit(1);
    console.log(`[pass ${pass}] ${full.status}/${full.phase ?? '-'} attempts=${full.attempts}${full.error ? ` err=${full.error}` : ''}`);
    if (full.status === 'completed' || full.status === 'failed') break;
  }

  if (full.status === 'completed') {
    console.log(`\n✅ Migration done. project_id=${full.projectId} session_id=${full.sessionId}`);
    console.log('progress:', JSON.stringify(full.progress, null, 2));
    // Migration no longer eager-provisions (sandboxes boot on-demand when a
    // session is opened), so just report the sessions it created.
    const sessions = await db.select({ sessionId: projectSessions.sessionId, branch: projectSessions.branchName, oc: projectSessions.opencodeSessionId })
      .from(projectSessions).where(eq(projectSessions.projectId, full.projectId!));
    console.log(`\nCreated ${sessions.length} session(s):`);
    for (const s of sessions) console.log(`  - ${s.branch}  (opencode ${s.oc ?? 'none'})`);
    process.exit(0);
  }
  console.log(`\n❌ Not completed: ${full.status} (${full.error ?? 'no error'})`);
  console.log('progress:', JSON.stringify(full.progress, null, 2));
  process.exit(1);
}

// Create the migration row but DON'T drive it — the long-lived dev API's resume
// worker picks it up and runs every phase (including the multi-minute Daytona
// snapshot build) in a networked, long-lived process. Local DB write only.
async function enqueue() {
  const sandboxId = env('TEST_SANDBOX_ID');
  const accountId = await resolveTargetAccount();
  const { migration, created } = await startMigration({ database: db, sandboxId, accountId, autoDrive: false });
  console.log(`${created ? '✅ Enqueued' : 'ℹ️  Already active'} migration ${migration.migrationId} (status=${migration.status}, phase=${migration.phase}).`);
  console.log('The dev API resume worker will drive it within ~60s. Watch the API logs / refresh the project.');
  process.exit(0);
}

// Restore chats into already-active session sandboxes for the account's latest
// migrated project. Open a session in the UI first (so its sandbox is active).
async function rehydrate() {
  const accountId = await resolveTargetAccount();
  const [project] = await db.select().from(projects).where(eq(projects.accountId, accountId)).orderBy(desc(projects.createdAt)).limit(1);
  if (!project) { console.error('No project for this account'); process.exit(1); }
  const legacySandboxId = (project.metadata as { legacy_migration?: { source_sandbox_id?: string } })?.legacy_migration?.source_sandbox_id;
  if (!legacySandboxId) { console.error('Project has no legacy_migration.source_sandbox_id'); process.exit(1); }
  console.log(`project=${project.projectId} legacy=${legacySandboxId}`);
  const sandboxesForAccount = await db
    .select({ sessionId: sessionSandboxes.sessionId, ext: sessionSandboxes.externalId, status: sessionSandboxes.status })
    .from(sessionSandboxes).where(eq(sessionSandboxes.accountId, accountId));
  const targets = sandboxesForAccount.filter((s) => s.status === 'active' && s.ext);
  console.log(`active session sandboxes: ${targets.length} (of ${sandboxesForAccount.length})`);
  if (!targets.length) { console.log('Open a session in the UI first so its sandbox is active.'); process.exit(0); }
  for (const t of targets) {
    console.log(`rehydrating session ${t.sessionId} (sandbox ${t.ext})...`);
    await rehydrateSessionChat({ sessionId: t.sessionId, legacySandboxId, newExternalId: t.ext! });
    console.log('  done');
  }
  console.log('\n✅ Rehydrate complete. Refresh the session — the original chat should appear.');
  process.exit(0);
}

async function diag() {
  const legacy = fakeLegacyRow();
  try {
    const ep = await resolveLegacyVmEndpoint(legacy as never);
    console.log('✅ resolveEndpoint OK ->', ep.url);
    try {
      const r = await execOnLegacyVm(ep, "bash -c 'echo hi'", 30);
      console.log(`   vm exec: exit=${r.exitCode} out=${r.stdout.trim()} err=${r.stderr.slice(0, 200)}`);
    } catch (e) { console.log('   ❌ vm exec ERR:', String(e)); }
  } catch (e) { console.log('❌ resolveEndpoint ERR:', String(e)); }
  try {
    await ensureBackupBucket();
    console.log('✅ storage OK -> backup bucket reachable');
  } catch (e) { console.log('❌ storage ERR:', String(e)); }
  process.exit(0);
}

const mode = process.argv.find((a) => ['--probe', '--seed', '--migrate', '--diag', '--enqueue', '--rehydrate'].includes(a));
if (mode === '--diag') await diag();
else if (mode === '--enqueue') await enqueue();
else if (mode === '--rehydrate') await rehydrate();
else
// Explicit exits: the DB pool holds the event loop open, so we can't rely on a
// natural exit once we've touched the database.
if (mode === '--probe') { await probe(); process.exit(0); }
else if (mode === '--seed') { await seed(); process.exit(0); }
else if (mode === '--migrate') await migrate(); // migrate() exits on its own
else { console.error('Pass one of: --probe | --seed | --migrate'); process.exit(2); }
