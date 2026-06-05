/**
 * Migrate a Suna (legacy agentpress) account's chats + files into ONE new
 * opencode project: 14 chats become 14 sessions in one opencode.db, and each
 * Suna sandbox's /workspace lands under legacy/<slug>/ (his content only — one
 * root kortix.toml for the repo).
 *
 *   --plan          READ-ONLY: discover projects/threads, Daytona sandbox state,
 *                   and build the opencode.db locally to prove the conversion.
 *   --build <dir>   Extract each sandbox's files into <dir>/legacy/<slug>/ and
 *                   write <dir>/opencode.db + manifest. Un-archives sandboxes
 *                   (Daytona), but writes NO repo / DB / provisioning.
 *   --apply         build + create repo + push + provision + rows. (Gated — next.)
 *
 * Usage:
 *   dotenvx run -f apps/api/.env.prod -- bun run src/scripts/migrate-suna-account.ts --account-id <uuid> --plan
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { getDaytona } from '../shared/daytona';
import { normalizeAgentpressThread, type AgentpressMessageRow, type NormalizedMessage } from '../projects/suna-migration/agentpress-mapper';
import { writeConversations, type SessionToWrite } from '../projects/suna-migration/opencode-db-writer';
import { extractWorkspace, slugify } from '../projects/suna-migration/suna-extract';
import { pushBundleAsRepo } from '../projects/suna-migration/suna-push';

function arg(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  return i >= 0 ? Bun.argv[i + 1] : Bun.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}
const accountId = arg('--account-id');
const buildDir = arg('--build');
const pushDir = arg('--push-repo');
const mode = pushDir ? 'push-repo' : Bun.argv.includes('--apply') ? 'apply' : buildDir ? 'build' : 'plan';
if (!accountId) { console.error('--account-id <uuid> required'); process.exit(2); }
if (mode === 'build' && !buildDir) { console.error('--build <dir> required'); process.exit(2); }

interface SunaProject { project_id: string; name: string; external_id: string | null; resource_status: string | null; }

async function discover(account: string) {
  const projects = (await db.execute(sql`
    SELECT p.project_id, COALESCE(NULLIF(p.name, ''), 'Untitled') AS name, r.external_id, r.status AS resource_status
    FROM public.projects p
    LEFT JOIN public.resources r ON r.id = p.sandbox_resource_id AND r.type = 'sandbox'
    WHERE p.account_id = ${account} ORDER BY p.created_at DESC
  `)) as unknown as SunaProject[];
  const threads = (await db.execute(sql`
    SELECT thread_id, project_id FROM public.threads WHERE account_id = ${account}
  `)) as unknown as Array<{ thread_id: string; project_id: string | null }>;
  return { projects, threads };
}

async function threadMessages(threadId: string): Promise<AgentpressMessageRow[]> {
  const rows = (await db.execute(sql`
    SELECT message_id, type, is_llm_message, content, created_at FROM public.messages
    WHERE thread_id = ${threadId} ORDER BY created_at ASC
  `)) as unknown as any[];
  return rows.map((r) => ({ ...r, created_at: String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at) }));
}

interface Unit { project: SunaProject; slug: string; session: SessionToWrite; }

async function buildUnits(account: string): Promise<{ units: Unit[]; projects: SunaProject[] }> {
  const { projects, threads } = await discover(account);
  const byProject = new Map<string, string[]>();
  for (const t of threads) { const k = t.project_id ?? ''; (byProject.get(k) ?? byProject.set(k, []).get(k)!).push(t.thread_id); }

  const units: Unit[] = [];
  const usedSlugs = new Set<string>();
  for (const p of projects) {
    const messages: NormalizedMessage[] = [];
    for (const tid of byProject.get(p.project_id) ?? []) messages.push(...normalizeAgentpressThread(await threadMessages(tid)));
    if (!messages.length) continue;
    let slug = slugify(p.name, p.project_id.slice(0, 8));
    if (usedSlugs.has(slug)) slug = `${slug}-${p.project_id.slice(0, 6)}`;
    usedSlugs.add(slug);
    units.push({ project: p, slug, session: { title: p.name.slice(0, 200), messages } });
  }
  return { units, projects };
}

function seedSchema(path: string) {
  const d = new Database(path);
  d.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, time_created INTEGER, time_initialized INTEGER);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
  `);
  d.close();
}

async function main() {
  console.log(`\n▸ Suna migration ${mode.toUpperCase()} — account ${accountId}\n`);
  const { units, projects } = await buildUnits(accountId!);
  console.log(`${projects.length} projects, ${units.length} with chat → 1 project / ${units.length} sessions.\n`);

  // ── PLAN: build the single opencode.db in temp, report ──
  if (mode === 'plan') {
    const work = mkdtempSync(join(tmpdir(), 'suna-plan-'));
    try {
      const dbPath = join(work, 'opencode.db');
      seedSchema(dbPath);
      const res = writeConversations(dbPath, 'proj_plan', units.map((u) => u.session));
      for (const u of units) console.log(`  ${u.slug.padEnd(40)} ${u.session.messages.length} msgs`);
      console.log(`\n── Plan ──\n  one project, ${res.sessions} sessions, ${res.messages} messages, ${res.parts} parts (real data ✓)`);
      if (res.unknownTables.length) console.log(`  ! unknown tables: ${res.unknownTables.join(', ')} (introspected at apply)`);
      console.log(`\n✓ plan only — nothing written.\n`);
    } finally { rmSync(work, { recursive: true, force: true }); }
    return;
  }

  // ── BUILD: extract files into <dir>/legacy/<slug>/, write the opencode.db ──
  if (mode === 'build') {
    const out = buildDir!;
    mkdirSync(join(out, 'legacy'), { recursive: true });
    const manifest: any[] = [];
    for (const u of units) {
      const dest = join(out, 'legacy', u.slug);
      mkdirSync(dest, { recursive: true });
      let files = 'no-sandbox', bytes = 0;
      if (u.project.external_id) {
        console.log(`  extracting ${u.slug} …`);
        const ex = await extractWorkspace(u.project.external_id);
        if (ex.tarball) {
          const tmp = join(out, '.tar.gz');
          writeFileSync(tmp, ex.tarball);
          const r = Bun.spawnSync(['tar', 'xzf', tmp, '-C', dest]);
          rmSync(tmp, { force: true });
          files = r.exitCode === 0 ? 'ok' : `untar-failed`;
          bytes = ex.bytes;
        } else files = ex.state;
      }
      manifest.push({ slug: u.slug, project_id: u.project.project_id, external_id: u.project.external_id, files, bytes, messages: u.session.messages.length });
      writeFileSync(join(dest, '.kortix-origin.json'), JSON.stringify(manifest[manifest.length - 1], null, 2));
      console.log(`  ${u.slug.padEnd(40)} files:${files.padEnd(14)} ${(bytes / 1024).toFixed(0)}KB  ${u.session.messages.length} msgs`);
    }
    const dbPath = join(out, 'opencode.db');
    seedSchema(dbPath);
    const res = writeConversations(dbPath, 'proj_suna', units.map((u) => u.session));
    writeFileSync(join(out, 'migration-manifest.json'), JSON.stringify({ accountId, sessions: res, units: manifest }, null, 2));
    console.log(`\n✓ bundle at ${out}\n  legacy/<slug>/ for ${manifest.length} sessions, opencode.db: ${res.sessions}s/${res.messages}m/${res.parts}p\n`);
    return;
  }

  // ── PUSH-REPO: create ONE managed repo, push the built bundle into it ──
  if (mode === 'push-repo') {
    console.log(`Pushing bundle ${pushDir} → a new managed repo …`);
    const repo = await pushBundleAsRepo(accountId!, pushDir!);
    console.log(`\n✓ pushed`);
    console.log(`  repo:       ${repo.upstreamUrl}`);
    console.log(`  project_id: ${repo.projectId}`);
    console.log(`  opencode.db kept aside: ${join(pushDir!, '..')}/${repo.projectId}.opencode.db`);
    console.log(`\n  Next: create the kortix.projects row for ${repo.projectId} pointed at this repo,`);
    console.log(`        then provision its sessions + ship the opencode.db (the API-side step).\n`);
    return;
  }

  console.error(`\n✗ --apply (project rows + provision + chat ship) is the API-side step — see suna-migration/. Use --build then --push-repo.\n`);
  process.exit(1);
}

await main();
process.exit(0);
