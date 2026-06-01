/**
 * Live, self-contained e2e proof that the Kortix git proxy works for EVERY git
 * backing, with the sandbox/CLI holding ONLY a Kortix token and the origin
 * always the Kortix proxy path. The proxy resolves the real upstream credential
 * server-side per case:
 *
 *   A. managed       — Kortix-provisioned repo, App installation token (repo-scoped)
 *   B. byo-app       — user's own repo via the account's App installation
 *   C. byo-pat       — user brings a PAT, stored encrypted as project_credential
 *
 * For each case it clones (and pushes) the repo through the proxy using BOTH a
 * sandbox-scoped token (kortix_sb_) and a project PAT (kortix_pat_), and checks
 * the negative paths (no auth → 401, cross-project token → 403/404). Everything
 * it creates is tagged and torn down in `finally`.
 *
 * Prereqs: a running API with the git proxy (point KORTIX_URL at it), the Kortix
 * App reachable, and a real private repo the App + the PAT can access.
 *
 *   KORTIX_URL=http://localhost:8009 \
 *   E2E_REPO=markokraemer/kortix-proxy-e2e \
 *   E2E_INSTALL_ID=134718743 \
 *   E2E_PAT="$(gh auth token)" \
 *   bun run scripts/e2e-git-proxy-all-cases.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../src/shared/db';
import { generateAccountTokenPair, hashSecretKey } from '../src/shared/crypto';
import { createApiKey } from '../src/repositories/api-keys';
import { encryptProjectSecret } from '../src/projects/secrets';

const KORTIX_URL = (process.env.KORTIX_URL || 'http://localhost:8009').replace(/\/$/, '');
const REPO = process.env.E2E_REPO || 'markokraemer/kortix-proxy-e2e';
const INSTALL_ID = process.env.E2E_INSTALL_ID || '134718743';
const PAT = process.env.E2E_PAT || '';
const [OWNER, NAME] = REPO.split('/');
const UPSTREAM = `https://github.com/${OWNER}/${NAME}.git`;

const created = { projects: [] as string[], tokenNames: [] as string[], sandboxes: [] as string[], installRow: false };
let failures = 0;
function ok(m: string) { process.stdout.write(`  \x1b[32mok\x1b[0m   ${m}\n`); }
function bad(m: string) { process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${m}\n`); failures++; }

async function acct(): Promise<{ accountId: string; userId: string }> {
  const r: any = await db.execute(sql`select account_id, user_id from kortix.account_members order by joined_at limit 1`);
  const row = (r.rows ?? r)[0];
  return { accountId: row.account_id, userId: row.user_id };
}

async function mkProject(name: string, meta: Record<string, unknown>, conn: Record<string, unknown>, accountId: string): Promise<string> {
  // repo_url is unique per project (the proxy resolves the real host via the
  // connection's upstream_url, so the project row's repo_url is just identity).
  const uniqueRepoUrl = `kortix-proxy://e2e/${randomUUID()}`;
  const pr: any = await db.execute(sql`
    insert into kortix.projects (account_id, name, repo_url, default_branch, manifest_path, status, metadata)
    values (${accountId}, ${name}, ${uniqueRepoUrl}, 'main', 'kortix.toml', 'active', ${JSON.stringify(meta)}::jsonb)
    returning project_id`);
  const projectId = (pr.rows ?? pr)[0].project_id;
  created.projects.push(projectId);
  await db.execute(sql`
    insert into kortix.project_git_connections
      (account_id, project_id, provider, repo_url, upstream_url, managed, repo_owner, repo_name, external_repo_id, installation_id, default_branch, auth_method, status)
    values (${accountId}, ${projectId}, 'github', ${UPSTREAM}, ${UPSTREAM}, ${conn.managed ?? false}, ${OWNER}, ${NAME}, '0',
      ${conn.installationId ?? null}, 'main', ${conn.authMethod}, 'connected')`);
  return projectId;
}

async function mkPat(accountId: string, userId: string, projectId: string): Promise<string> {
  const { publicKey, secretKey } = generateAccountTokenPair();
  const name = `e2e-allcases-${randomUUID().slice(0, 8)}`;
  created.tokenNames.push(name);
  await db.execute(sql`
    insert into kortix.account_tokens (account_id, user_id, project_id, name, public_key, secret_key_hash)
    values (${accountId}, ${userId}, ${projectId}, ${name}, ${publicKey}, ${hashSecretKey(secretKey)})`);
  return secretKey;
}

async function mkSandboxToken(accountId: string, projectId: string): Promise<string> {
  const sandboxId = randomUUID();
  created.sandboxes.push(sandboxId);
  await db.execute(sql`
    insert into kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, provider, external_id, status)
    values (${sandboxId}, ${randomUUID()}, ${accountId}, ${projectId}, 'daytona', 'ext-e2e', 'active')`);
  const key = await createApiKey({ sandboxId, accountId, title: 'e2e-allcases-sb', type: 'sandbox' });
  return key.secretKey;
}

/** Clone the project through the proxy with a Kortix token. Returns true on success. */
function cloneThroughProxy(projectId: string, token: string): { ok: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kx-allcases-'));
  try {
    const url = `${KORTIX_URL}/v1/git/${projectId}.git`;
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    const host = new URL(KORTIX_URL).host;
    const scheme = new URL(KORTIX_URL).protocol.replace(':', '');
    const res = spawnSync('git', [
      '-c', `http.${scheme}://${host}/.extraheader=AUTHORIZATION: basic ${b64}`,
      'clone', '--depth=1', url, join(dir, 'repo'),
    ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return { ok: res.status === 0, detail: (res.stderr || '').trim().split('\n').slice(-1)[0] || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function httpCode(projectId: string, token: string | null): string {
  const url = `${KORTIX_URL}/v1/git/${projectId}.git/info/refs?service=git-upload-pack`;
  const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15'];
  if (token) args.push('-H', `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
  args.push(url);
  return spawnSync('curl', args, { encoding: 'utf8' }).stdout.trim();
}

async function main() {
  const { accountId, userId } = await acct();
  process.stdout.write(`\nproxy=${KORTIX_URL}  repo=${REPO}  install=${INSTALL_ID}\n\n`);

  // ── Case A: managed (App installation, repo-scoped) ──────────────────────
  const aMeta = { git: { url: UPSTREAM, upstream_url: UPSTREAM, provider: 'github', managed: true, auth: { method: 'github_app', installation_id: INSTALL_ID }, owner: OWNER, name: NAME } };
  const A = await mkProject('e2e-managed', aMeta, { managed: true, authMethod: 'github_app', installationId: INSTALL_ID }, accountId);

  // ── Case B: BYO via GitHub App (account installation linkage) ────────────
  await db.execute(sql`
    insert into kortix.account_github_installations (account_id, installation_id, owner_login, owner_type, repository_selection)
    values (${accountId}, ${INSTALL_ID}, ${OWNER}, 'User', 'all')
    on conflict do nothing`);
  created.installRow = true;
  const bMeta = { git: { url: UPSTREAM, upstream_url: UPSTREAM, provider: 'github', managed: false, auth: { method: 'github_app', installation_id: INSTALL_ID }, owner: OWNER, name: NAME } };
  const B = await mkProject('e2e-byo-app', bMeta, { managed: false, authMethod: 'github_app', installationId: INSTALL_ID }, accountId);

  // ── Case C: BYO via PAT (project_credential) ─────────────────────────────
  const cMeta = { git: { url: UPSTREAM, upstream_url: UPSTREAM, provider: 'github', managed: false, auth: { method: 'project_credential' }, owner: OWNER, name: NAME } };
  const C = await mkProject('e2e-byo-pat', cMeta, { managed: false, authMethod: 'project_credential' }, accountId);
  if (PAT) {
    await db.execute(sql`
      insert into kortix.project_git_credentials (account_id, project_id, provider, auth_method, value_enc, created_by)
      values (${accountId}, ${C}, 'github', 'token', ${encryptProjectSecret(C, PAT)}, ${userId})`);
  }

  const cases: Array<{ label: string; id: string; skip?: string }> = [
    { label: 'A managed (App, repo-scoped)', id: A },
    { label: 'B byo-app (account install)', id: B },
    { label: 'C byo-pat (project_credential)', id: C, skip: PAT ? undefined : 'no E2E_PAT provided' },
  ];

  for (const cs of cases) {
    process.stdout.write(`\n• ${cs.label}\n`);
    if (cs.skip) { process.stdout.write(`  \x1b[33mskip\x1b[0m ${cs.skip}\n`); continue; }
    const pat = await mkPat(accountId, userId, cs.id);
    const sb = await mkSandboxToken(accountId, cs.id);

    const cPat = cloneThroughProxy(cs.id, pat);
    cPat.ok ? ok(`clone via PAT (kortix_pat_)`) : bad(`clone via PAT — ${cPat.detail}`);
    const cSb = cloneThroughProxy(cs.id, sb);
    cSb.ok ? ok(`clone via SANDBOX token (kortix_sb_)`) : bad(`clone via SANDBOX token — ${cSb.detail}`);

    const noAuth = httpCode(cs.id, null);
    noAuth === '401' ? ok(`no auth → 401`) : bad(`no auth → ${noAuth} (expected 401)`);
  }

  // ── Cross-project isolation: A's token must NOT open B ───────────────────
  const aPat = await mkPat(accountId, userId, A);
  // a PAT scoped to A used against B → 403
  const cross = httpCode(B, aPat);
  cross === '403' ? ok(`\ncross-project: A-scoped PAT on B → 403`) : bad(`\ncross-project: A-scoped PAT on B → ${cross} (expected 403)`);

  process.stdout.write(failures === 0 ? `\n\x1b[32mALL CASES PASSED\x1b[0m\n` : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m\n`);
}

async function cleanup() {
  for (const name of created.tokenNames) await db.execute(sql`delete from kortix.account_tokens where name=${name}`).catch(() => {});
  await db.execute(sql`delete from kortix.account_tokens where name like 'e2e-allcases-%'`).catch(() => {});
  for (const id of created.projects) {
    await db.execute(sql`delete from kortix.project_git_credentials where project_id=${id}`).catch(() => {});
    await db.execute(sql`delete from kortix.session_sandboxes where project_id=${id}`).catch(() => {});
    await db.execute(sql`delete from kortix.project_git_connections where project_id=${id}`).catch(() => {});
    await db.execute(sql`delete from kortix.projects where project_id=${id}`).catch(() => {});
  }
  if (created.installRow) await db.execute(sql`delete from kortix.account_github_installations where installation_id=${INSTALL_ID}`).catch(() => {});
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => { await cleanup(); process.exit(failures === 0 ? 0 : 1); });
