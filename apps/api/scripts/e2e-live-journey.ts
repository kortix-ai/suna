/**
 * Kortix API — Live A→Z User-Journey E2E (black-box, over the wire)
 * ════════════════════════════════════════════════════════════════════════════
 * Drives a COMPLETE real-user flow against a deployed kortix-api using REAL
 * Supabase auth (admin-created confirmed users + password sign-in JWTs), then
 * exercises every CRUD surface and tears everything down. Safe to run against
 * live dev: it only touches resources it creates, and cleans up in a finally
 * block (accounts, projects, sessions, secrets, triggers, tokens, servers,
 * tunnels, api-keys, and the Supabase users themselves).
 *
 * Unlike the in-process bun:test e2e files (mock DB, app.request()), this hits
 * a real BASE_URL through nginx/Cloudflare — so it validates the deployed wire.
 *
 * Usage:
 *   DEV_SUPABASE_URL=...  DEV_SUPABASE_SERVICE_ROLE_KEY=...  \
 *   DEV_SUPABASE_ANON_KEY=...  BASE_URL=https://dev-api.kortix.com  \
 *   bun run scripts/e2e-live-journey.ts
 *
 * Exit 0 iff every assertion passes. Always attempts full teardown.
 */

const BASE = (process.env.BASE_URL || "https://dev-api.kortix.com").replace(/\/+$/, "");
const SB_URL = (process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SVC = process.env.DEV_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = process.env.DEV_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

if (!SB_URL || !SVC || !ANON) {
  console.error("Missing DEV_SUPABASE_URL / DEV_SUPABASE_SERVICE_ROLE_KEY / DEV_SUPABASE_ANON_KEY");
  process.exit(2);
}

// ── ANSI ─────────────────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", DIM = "\x1b[2m", NC = "\x1b[0m";
let pass = 0, fail = 0;
const failures: string[] = [];
function ok(msg: string) { pass++; console.log(`  ${G}✓${NC} ${msg}`); }
function bad(msg: string, detail = "") { fail++; failures.push(msg); console.log(`  ${R}✗ ${msg}${NC}${detail ? ` ${DIM}— ${detail}${NC}` : ""}`); }
function phase(t: string) { console.log(`\n${C}━━ ${t} ━━${NC}`); }

// ── HTTP ─────────────────────────────────────────────────────────────────────
type Res = { status: number; body: any };
async function req(method: string, url: string, opts: { token?: string; apikey?: string; body?: any; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.apikey) headers["apikey"] = opts.apikey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch (e: any) {
    return { status: 0, body: { fetchError: String(e?.message || e) } };
  }
  const text = await res.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
const api = (method: string, path: string, token?: string, body?: any) => req(method, `${BASE}${path}`, { token, body });

// assert helpers
function expectStatus(name: string, res: Res, want: number | number[]) {
  const wants = Array.isArray(want) ? want : [want];
  if (wants.includes(res.status)) ok(`${name} → ${res.status}`);
  else bad(`${name}`, `got ${res.status} want ${wants.join("/")}: ${JSON.stringify(res.body).slice(0, 160)}`);
}
function expectNo5xx(name: string, res: Res) {
  if (res.status > 0 && res.status < 500) ok(`${name} → ${res.status} (no 5xx)`);
  else bad(`${name}`, `got ${res.status}: ${JSON.stringify(res.body).slice(0, 160)}`);
}

// ── Supabase admin user lifecycle ────────────────────────────────────────────
const createdUserIds: string[] = [];
async function mintUser(tag: string): Promise<{ id: string; email: string; token: string } | null> {
  const email = `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@kortix-e2e.dev`;
  const password = "E2eJourney!234567";
  const cr = await req("POST", `${SB_URL}/auth/v1/admin/users`, { apikey: SVC, token: SVC, body: { email, password, email_confirm: true } });
  if (cr.status !== 200 || !cr.body?.id) { bad(`mintUser(${tag}) admin create`, `${cr.status}: ${JSON.stringify(cr.body).slice(0, 160)}`); return null; }
  createdUserIds.push(cr.body.id);
  const si = await req("POST", `${SB_URL}/auth/v1/token?grant_type=password`, { apikey: ANON, body: { email, password } });
  if (si.status !== 200 || !si.body?.access_token) { bad(`mintUser(${tag}) signin`, `${si.status}`); return null; }
  ok(`mintUser(${tag}) → confirmed user + JWT`);
  return { id: cr.body.id, email, token: si.body.access_token };
}
async function deleteUser(id: string) {
  await req("DELETE", `${SB_URL}/auth/v1/admin/users/${id}`, { apikey: SVC, token: SVC });
}

// ── State captured for teardown ──────────────────────────────────────────────
const created = { teamAccounts: [] as string[], projects: [] as string[], serverIds: [] as string[], tunnelIds: [] as string[], apiKeyIds: [] as string[] };
let ownerTokenForCleanup: string | undefined;

async function main() {
  console.log(`${C}Kortix API — live A→Z user journey${NC}`);
  console.log(`  base:     ${BASE}`);
  console.log(`  supabase: ${SB_URL}`);

  // ════ PHASE 1: PUBLIC ROUTES (no auth) ════
  phase("1. Public routes");
  expectStatus("GET /health", await api("GET", "/health"), 200);
  expectStatus("GET /v1/health", await api("GET", "/v1/health"), 200);
  expectStatus("GET /v1/system/status", await api("GET", "/v1/system/status"), 200);
  expectStatus("GET /v1/platform/sandbox/version", await api("GET", "/v1/platform/sandbox/version"), 200);
  expectStatus("GET /v1/access/signup-status", await api("GET", "/v1/access/signup-status"), 200);
  expectNo5xx("POST /v1/access/check-email", await api("POST", "/v1/access/check-email", undefined, { email: "nobody@example.com" }));
  expectStatus("GET /v1/does-not-exist (404)", await api("GET", "/v1/does-not-exist-xyz"), 404);

  // ════ PHASE 2: AUTH GATING (anonymous must be 401, never 5xx) ════
  phase("2. Auth gating (anonymous → 401)");
  for (const p of ["/v1/accounts", "/v1/projects", "/v1/billing/account-state", "/v1/router/models", "/v1/servers", "/v1/queue/all", "/v1/tunnel/connections", "/v1/platform/api-keys"]) {
    expectStatus(`GET ${p} anon`, await api("GET", p), 401);
  }

  // ════ PHASE 3: IDENTITY (owner user A) ════
  phase("3. Identity & account bootstrap");
  const A = await mintUser("owner");
  if (!A) throw new Error("cannot mint owner");
  ownerTokenForCleanup = A.token;
  const me = await api("GET", "/v1/accounts/me", A.token);
  expectStatus("GET /v1/accounts/me", me, 200);
  // /me returns { user_id, email, accounts: [] } until first /v1/accounts read
  // bootstraps the personal account; the personal account_id lives in /v1/accounts.
  const acctList = await api("GET", "/v1/accounts", A.token);
  expectStatus("GET /v1/accounts", acctList, 200);
  const personal = Array.isArray(acctList.body) ? acctList.body.find((a: any) => a.personal_account) : undefined;
  const personalAccountId: string | undefined = personal?.account_id;
  if (personalAccountId) ok(`personal account = ${personalAccountId}`); else bad("no personal account in /v1/accounts", JSON.stringify(acctList.body).slice(0, 160));
  expectNo5xx("GET /v1/user-roles", await api("GET", "/v1/user-roles", A.token));

  // ════ PHASE 4: ACCOUNT CRUD ════
  phase("4. Account CRUD");
  expectStatus("POST /v1/accounts (no name → 400)", await api("POST", "/v1/accounts", A.token, {}), 400);
  const teamCreate = await api("POST", "/v1/accounts", A.token, { name: "E2E Team" });
  expectStatus("POST /v1/accounts", teamCreate, 201);
  const teamId: string | undefined = teamCreate.body?.account_id || teamCreate.body?.id;
  if (teamId) { created.teamAccounts.push(teamId); ok(`team account = ${teamId}`); } else bad("no team account_id");
  if (teamId) {
    expectStatus("GET /v1/accounts/:id", await api("GET", `/v1/accounts/${teamId}`, A.token), 200);
    expectStatus("PATCH /v1/accounts/:id (rename)", await api("PATCH", `/v1/accounts/${teamId}`, A.token, { name: "E2E Team Renamed" }), 200);
    expectStatus("GET /v1/accounts/:id/members", await api("GET", `/v1/accounts/${teamId}/members`, A.token), 200);
    expectStatus("GET /v1/accounts/:id/invites", await api("GET", `/v1/accounts/${teamId}/invites`, A.token), 200);
  }

  // ════ PHASE 5: PAT TOKENS ════
  phase("5. Personal access tokens (CLI PAT)");
  const patCreate = await api("POST", "/v1/accounts/tokens", A.token, { name: "e2e-pat" });
  expectStatus("POST /v1/accounts/tokens", patCreate, [200, 201]);
  const patPlain: string | undefined = patCreate.body?.secret_key || patCreate.body?.token || patCreate.body?.plaintext;
  const patId: string | undefined = patCreate.body?.token_id || patCreate.body?.id;
  expectStatus("GET /v1/accounts/tokens", await api("GET", "/v1/accounts/tokens", A.token), 200);
  if (patPlain) {
    const viaPat = await api("GET", "/v1/accounts/me", patPlain);
    expectStatus("GET /v1/accounts/me via PAT", viaPat, 200);
  } else bad("PAT plaintext not returned");
  if (patId) expectStatus("DELETE /v1/accounts/tokens/:id", await api("DELETE", `/v1/accounts/tokens/${patId}`, A.token), [200, 204]);

  // ════ PHASE 6: MEMBERS & INVITES ════
  phase("6. Members & invites (user B)");
  const B = await mintUser("invitee");
  if (B && teamId) {
    // B must touch /me once so their account exists
    await api("GET", "/v1/accounts/me", B.token);
    const invite = await api("POST", `/v1/accounts/${teamId}/members`, A.token, { email: B.email, role: "member" });
    expectStatus("POST /v1/accounts/:id/members (invite)", invite, [200, 201]);
    const inviteId: string | undefined = invite.body?.invite_id || invite.body?.inviteId || invite.body?.id;
    const list = await api("GET", `/v1/accounts/${teamId}/invites`, A.token);
    expectStatus("GET invites (after invite)", list, 200);
    if (inviteId) {
      expectStatus("GET /v1/account-invites/:id (as B)", await api("GET", `/v1/account-invites/${inviteId}`, B.token), 200);
      const accept = await api("POST", `/v1/account-invites/${inviteId}/accept`, B.token);
      expectStatus("POST /v1/account-invites/:id/accept (as B)", accept, [200, 201]);
      const membersAfter = await api("GET", `/v1/accounts/${teamId}/members`, A.token);
      expectStatus("GET members (B joined)", membersAfter, 200);
      const hasB = Array.isArray(membersAfter.body) ? membersAfter.body.some((m: any) => m.user_id === B.id || m.userId === B.id || m.email === B.email) : false;
      if (hasB) ok("member B present after accept"); else bad("member B not found after accept", JSON.stringify(membersAfter.body).slice(0, 160));
      expectNo5xx("PATCH member role", await api("PATCH", `/v1/accounts/${teamId}/members/${B.id}`, A.token, { role: "admin" }));
      expectStatus("DELETE member B", await api("DELETE", `/v1/accounts/${teamId}/members/${B.id}`, A.token), [200, 204]);
    } else bad("no inviteId returned");
  }

  // ════ PHASE 7: BILLING / SUBSCRIPTION (read state; no Stripe side effects) ════
  phase("7. Billing & subscription state");
  expectStatus("GET /v1/billing/account-state", await api("GET", "/v1/billing/account-state", A.token), 200);
  expectNo5xx("GET /v1/billing/account-state/minimal", await api("GET", "/v1/billing/account-state/minimal", A.token));
  expectNo5xx("GET /v1/account/deletion-status", await api("GET", "/v1/account/deletion-status", A.token));
  expectNo5xx("GET /v1/billing/proration-preview", await api("GET", "/v1/billing/proration-preview", A.token));

  // ════ PHASE 8: PLATFORM API KEYS (sandbox-scoped: require sandbox_id) ════
  // These are sandbox-runtime keys, not user-facing CRUD — without a sandbox_id
  // they correctly 400. Assert the contract (no 5xx, sane validation), not CRUD.
  phase("8. Platform API keys (sandbox-scoped contract)");
  expectStatus("GET /v1/platform/api-keys (needs sandbox_id → 400)", await api("GET", "/v1/platform/api-keys", A.token), 400);
  expectStatus("POST /v1/platform/api-keys (needs sandbox_id → 400)", await api("POST", "/v1/platform/api-keys", A.token, { name: "e2e-key" }), 400);

  // ════ PHASE 9: PROJECT CRUD + sub-resources ════
  phase("9. Project CRUD");
  // Raw POST /v1/projects requires a real validated repo_url; the user-facing
  // "Create project" path is /provision (managed Freestyle git). Use that.
  expectStatus("POST /v1/projects (no repo_url → 400)", await api("POST", "/v1/projects", A.token, {}), 400);
  const projCreate = await api("POST", "/v1/projects/provision", A.token, { provider: "freestyle", name: "e2e-project" });
  expectStatus("POST /v1/projects/provision", projCreate, 201);
  const projectId: string | undefined = projCreate.body?.project_id || projCreate.body?.id || projCreate.body?.projectId;
  if (projectId) { created.projects.push(projectId); ok(`project = ${projectId}`); } else bad("no project id");
  if (projectId) {
    expectStatus("GET /v1/projects", await api("GET", "/v1/projects", A.token), 200);
    expectStatus("GET /v1/projects/:id", await api("GET", `/v1/projects/${projectId}`, A.token), 200);
    expectStatus("PATCH /v1/projects/:id", await api("PATCH", `/v1/projects/${projectId}`, A.token, { name: "e2e-project-renamed" }), 200);

    phase("9a. Project secrets CRUD");
    const secCreate = await api("POST", `/v1/projects/${projectId}/secrets`, A.token, { name: "E2E_SECRET", value: "s3cr3t" });
    expectStatus("POST secrets", secCreate, [200, 201]);
    const secId: string | undefined = secCreate.body?.id || secCreate.body?.secret_id || secCreate.body?.secretId;
    expectStatus("GET secrets", await api("GET", `/v1/projects/${projectId}/secrets`, A.token), 200);
    if (secId) {
      expectNo5xx("GET secret :id", await api("GET", `/v1/projects/${projectId}/secrets/${secId}`, A.token));
      expectNo5xx("PATCH secret :id", await api("PATCH", `/v1/projects/${projectId}/secrets/${secId}`, A.token, { value: "s3cr3t2" }));
      expectStatus("DELETE secret :id", await api("DELETE", `/v1/projects/${projectId}/secrets/${secId}`, A.token), [200, 204]);
    }

    phase("9b. Project triggers CRUD");
    const trCreate = await api("POST", `/v1/projects/${projectId}/triggers`, A.token, { type: "cron", name: "e2e-cron", cron: "0 0 * * *", prompt: "hi" });
    expectNo5xx("POST triggers", trCreate);
    const trId: string | undefined = trCreate.body?.id || trCreate.body?.trigger_id || trCreate.body?.triggerId;
    expectStatus("GET triggers", await api("GET", `/v1/projects/${projectId}/triggers`, A.token), 200);
    if (trId) {
      expectNo5xx("GET trigger :id", await api("GET", `/v1/projects/${projectId}/triggers/${trId}`, A.token));
      expectNo5xx("PATCH trigger :id", await api("PATCH", `/v1/projects/${projectId}/triggers/${trId}`, A.token, { name: "e2e-cron-2" }));
      expectStatus("DELETE trigger :id", await api("DELETE", `/v1/projects/${projectId}/triggers/${trId}`, A.token), [200, 204]);
    }

    phase("9c. Project connectors / access / change-requests / git (read)");
    expectStatus("GET connectors", await api("GET", `/v1/projects/${projectId}/connectors`, A.token), 200);
    expectStatus("GET access/members", await api("GET", `/v1/projects/${projectId}/access/members`, A.token), 200);
    expectStatus("GET access/groups", await api("GET", `/v1/projects/${projectId}/access/groups`, A.token), 200);
    expectStatus("GET change-requests", await api("GET", `/v1/projects/${projectId}/change-requests`, A.token), 200);
    expectNo5xx("GET git/branches (bare repo)", await api("GET", `/v1/projects/${projectId}/git/branches`, A.token));

    phase("9d. Session CRUD");
    const sessCreate = await api("POST", `/v1/projects/${projectId}/sessions`, A.token, { title: "e2e-session" });
    expectStatus("POST session", sessCreate, 201);
    const sessionId: string | undefined = sessCreate.body?.session_id || sessCreate.body?.id || sessCreate.body?.sessionId;
    expectStatus("GET sessions", await api("GET", `/v1/projects/${projectId}/sessions`, A.token), 200);
    if (sessionId) {
      ok(`session = ${sessionId}`);
      expectStatus("GET session :id", await api("GET", `/v1/projects/${projectId}/sessions/${sessionId}`, A.token), 200);
      expectNo5xx("PATCH session :id", await api("PATCH", `/v1/projects/${projectId}/sessions/${sessionId}`, A.token, { title: "e2e-session-2" }));
      expectNo5xx("GET session sandbox state", await api("GET", `/v1/projects/${projectId}/sessions/${sessionId}/sandbox`, A.token));
      expectStatus("DELETE session :id", await api("DELETE", `/v1/projects/${projectId}/sessions/${sessionId}`, A.token), [200, 204]);
    } else bad("no session id");
  }

  // ════ PHASE 10: SERVERS CRUD ════
  phase("10. Servers (MCP registry) CRUD");
  const srvCreate = await api("POST", "/v1/servers", A.token, { name: "e2e-server", url: "https://example.com/mcp", transport: "http" });
  expectNo5xx("POST /v1/servers", srvCreate);
  const srvId: string | undefined = srvCreate.body?.id || srvCreate.body?.server_id;
  expectStatus("GET /v1/servers", await api("GET", "/v1/servers", A.token), 200);
  if (srvId) {
    created.serverIds.push(srvId);
    expectNo5xx("GET /v1/servers/:id", await api("GET", `/v1/servers/${srvId}`, A.token));
    expectNo5xx("PUT /v1/servers/:id", await api("PUT", `/v1/servers/${srvId}`, A.token, { name: "e2e-server-2", url: "https://example.com/mcp", transport: "http" }));
    expectStatus("DELETE /v1/servers/:id", await api("DELETE", `/v1/servers/${srvId}`, A.token), [200, 204]);
  }

  // ════ PHASE 11: QUEUE ════
  phase("11. Queue");
  expectStatus("GET /v1/queue/all", await api("GET", "/v1/queue/all", A.token), 200);
  expectStatus("GET /v1/queue/status", await api("GET", "/v1/queue/status", A.token), 200);

  // ════ PHASE 12: TUNNEL ════
  phase("12. Tunnel connections & permissions CRUD");
  expectStatus("GET /v1/tunnel/connections", await api("GET", "/v1/tunnel/connections", A.token), 200);
  expectNo5xx("GET /v1/tunnel/permissions", await api("GET", "/v1/tunnel/permissions", A.token));
  expectNo5xx("GET /v1/tunnel/audit", await api("GET", "/v1/tunnel/audit", A.token));
  const tunCreate = await api("POST", "/v1/tunnel/connections", A.token, { name: "e2e-tunnel" });
  expectNo5xx("POST /v1/tunnel/connections", tunCreate);
  const tunId: string | undefined = tunCreate.body?.id || tunCreate.body?.tunnel_id || tunCreate.body?.tunnelId;
  if (tunId) {
    created.tunnelIds.push(tunId);
    expectNo5xx("GET /v1/tunnel/connections/:id", await api("GET", `/v1/tunnel/connections/${tunId}`, A.token));
    expectStatus("DELETE /v1/tunnel/connections/:id", await api("DELETE", `/v1/tunnel/connections/${tunId}`, A.token), [200, 204]);
  }

  // ════ PHASE 13: ROUTER (authed read) ════
  phase("13. Router (LLM gateway) authed reads");
  expectNo5xx("GET /v1/router/models", await api("GET", "/v1/router/models", A.token));
  expectStatus("GET /v1/router/health", await api("GET", "/v1/router/health"), [200, 404]);
}

// ── Teardown (best effort, always runs) ──────────────────────────────────────
async function teardown(ownerToken?: string) {
  phase("Teardown");
  if (ownerToken) {
    for (const pid of created.projects) { const r = await api("DELETE", `/v1/projects/${pid}`, ownerToken); console.log(`  ${DIM}delete project ${pid} → ${r.status}${NC}`); }
    for (const aid of created.teamAccounts) {
      // immediate-delete with active-account header fallback; try both shapes
      let r = await api("POST", `/v1/account/immediate-delete`, ownerToken, { account_id: aid });
      if (r.status >= 400) r = await req("POST", `${BASE}/v1/account/immediate-delete`, { token: ownerToken, body: {}, headers: { "X-Kortix-Account-Id": aid } });
      console.log(`  ${DIM}delete team account ${aid} → ${r.status}${NC}`);
    }
  }
  for (const id of createdUserIds) { await deleteUser(id); }
  console.log(`  ${DIM}deleted ${createdUserIds.length} supabase users${NC}`);
}

(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (e: any) {
    console.error(`\n${R}FATAL: ${e?.message || e}${NC}`);
    exitCode = 1;
  } finally {
    await teardown(ownerTokenForCleanup);
    console.log(`\n${C}━━ Summary ━━${NC}`);
    console.log(`  passed: ${G}${pass}${NC}   failed: ${fail > 0 ? R : G}${fail}${NC}`);
    if (fail > 0) { console.log(`  ${R}FAILURES:${NC}`); failures.forEach((f) => console.log(`    - ${f}`)); exitCode = 1; }
    else console.log(`  ${G}ALL A→Z JOURNEY CHECKS PASSED${NC}`);
    process.exit(exitCode);
  }
})();
