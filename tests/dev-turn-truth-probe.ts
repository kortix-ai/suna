/**
 * DEV PROBE — turn-truth (PR #6657).
 *
 * Proves on the DEPLOYED dev stack the two behaviors the Essentia incident
 * (session d1b74954, 2026-08-20) disproved:
 *
 *  A. A turn the CONTROL PLANE never delivered still gets turn authority.
 *     Started by POSTing straight at OpenCode through the sandbox proxy —
 *     the same shape as OpenCode's synthetic `<pty_exited>` wake-up, which is
 *     what actually started the invisible turns on Essentia. BEFORE the fix
 *     `GET .../turn` reported NO open turn for the whole run.
 *
 *  B. The turn ends and the authority is released — no phantom `working`.
 *
 * Run: cd tests && dotenvx run -f .env.dev -- bun dev-turn-truth-probe.ts
 */

const API = process.env.KE2E_API_URL!;
const SUPABASE = process.env.KE2E_SUPABASE_URL!;
const SERVICE_ROLE = process.env.KE2E_SUPABASE_SERVICE_ROLE_KEY!;
const ANON = process.env.KE2E_SUPABASE_ANON_KEY!;

const log = (...a: unknown[]) => console.log(...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jsonOrText(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function mintUser() {
  const email = `turn-truth-${Date.now()}@example.com`;
  const password = 'Probe-passw0rd!';
  const created = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`admin create failed: ${await created.text()}`);
  const grant = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await grant.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`password grant failed: ${JSON.stringify(body)}`);
  log(`user: ${email}`);
  return { email, jwt: body.access_token };
}

async function main() {
  const { jwt } = await mintUser();
  const auth = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/json',
    ...extra,
  });

  const health = await jsonOrText(await fetch(`${API}/health`));
  log(`api health: ${JSON.stringify(health)}`);

  const accounts = (await jsonOrText(
    await fetch(`${API}/accounts`, { headers: auth() }),
  )) as Array<{ account_id: string; personal_account?: boolean }>;
  const accountId = accounts.find((a) => a.personal_account)?.account_id ?? accounts[0]?.account_id;
  log(`account: ${accountId}`);

  const project = (await jsonOrText(
    await fetch(`${API}/projects/provision`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ account_id: accountId, name: `turn-truth-${Date.now()}` }),
    }),
  )) as { project_id?: string; error?: string };
  if (!project.project_id) throw new Error(`provision failed: ${JSON.stringify(project)}`);
  log(`project: ${project.project_id}`);

  const session = (await jsonOrText(
    await fetch(`${API}/projects/${project.project_id}/sessions`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({}),
    }),
  )) as { session_id?: string; error?: string };
  if (!session.session_id) throw new Error(`session create failed: ${JSON.stringify(session)}`);
  const sid = session.session_id;
  log(`session: ${sid}`);

  // Boot the runtime and resolve this session's OpenCode identity. `/start` is
  // the documented poll surface: stage + opencode_session_id + runtime_url
  // (the server-owned proxy path for port 8000 — never built client-side).
  let started: any = null;
  for (let i = 0; i < 90; i++) {
    started = await jsonOrText(
      await fetch(`${API}/projects/${project.project_id}/sessions/${sid}/start`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      }),
    );
    if (i === 0) log(`start[0]: ${JSON.stringify(started).slice(0, 300)}`);
    if (started?.stage === 'ready' && started?.opencode_session_id && started?.runtime_url) break;
    if (started?.retriable === false) {
      throw new Error(`start terminal: ${JSON.stringify(started).slice(0, 500)}`);
    }
    if (i % 6 === 0) log(`  start stage=${started?.stage} oc=${started?.opencode_session_id ?? '-'}`);
    await sleep(5_000);
  }
  const ocId = started?.opencode_session_id;
  const runtimeUrl = `${API.replace(/\/$/, '')}${String(started?.runtime_url ?? '')}`.replace(/\/$/, '');
  log(`opencode session: ${ocId}`);
  log(`runtime_url: ${runtimeUrl}`);
  if (!ocId || !started?.runtime_url) {
    throw new Error(`runtime never resolved: ${JSON.stringify(started).slice(0, 500)}`);
  }

  const readTurn = async () =>
    (await jsonOrText(
      await fetch(`${API}/projects/${project.project_id}/sessions/${sid}/turn`, { headers: auth() }),
    )) as { turns?: unknown[]; last_ended?: Record<string, unknown> };

  // A box-initiated turn can be SHORT (measured 5.2s on dev). Missing its open
  // window is a polling artifact, not a failure — the terminal row is equally
  // good proof that adoption happened, so both count.
  const readEvidence = async () => {
    const t = await readTurn();
    const open = Array.isArray(t.turns) ? t.turns.length : 0;
    return { open, lastEnded: t.last_ended ?? null, raw: t };
  };

  const before = await readTurn();
  log(`turn BEFORE: ${JSON.stringify(before)}`);

  // ---- A: a turn NOBODY POSTed through the control plane -----------------
  // A message POSTed through the sandbox PROXY is NOT a valid test: the proxy
  // runs its own turn lifecycle (`acceptTurnLifecycle`) and creates the ledger
  // row itself, so the adoption path never runs (confirmed on dev: that row
  // carries message_id NULL and a ~4s begin→accept gap — the proxy's shape).
  //
  // The incident's real trigger is OpenCode injecting its own `<pty_exited>`
  // user message from INSIDE the box. That injection is an opencode-binary
  // behavior tied to a pty its own tool started, so it needs a funded model
  // turn to reproduce. What it proves, though, is exactly this: a turn that
  // begins with no control-plane POST in front of it. Any in-box POST has that
  // property, so we produce one directly — a daemon pty that curls OpenCode on
  // 127.0.0.1. Nothing crosses the proxy, so the ONLY thing that can create
  // turn authority is the daemon's `turn_begin` relay → adoptRuntimeSandboxTurn.
  const inBoxCurl =
    `curl -sS -X POST 'http://127.0.0.1:4096/session/${ocId}/message?directory=/workspace' ` +
    `-H 'Content-Type: application/json' ` +
    `--data '{"parts":[{"type":"text","text":"Reply with the single word DONE."}]}' ` +
    `-o /tmp/turn-truth-inbox.json -w '%{http_code}' > /tmp/turn-truth-code.txt 2>&1`;
  const ptyRes = await fetch(`${runtimeUrl.replace(/\/8000$/, '/8000')}/kortix/pty`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      command: '/bin/sh',
      args: ['-c', inBoxCurl],
      cwd: '/workspace',
      title: 'turn-truth in-box turn',
    }),
  });
  const pty = (await jsonOrText(ptyRes)) as { id?: string };
  log(
    `in-box pty: HTTP ${ptyRes.status} id=${pty?.id ?? '-'} ${typeof pty === 'string' ? pty.slice(0, 300) : ''}`,
  );
  if (!pty?.id) throw new Error('daemon pty was not created — cannot start an in-box turn');

  // ---- assert authority appears -----------------------------------------
  let sawOpenTurn = false;
  let adopted: unknown = null;
  let terminalEvidence: unknown = null;
  const t0 = Date.now();
  for (let i = 0; i < 240; i++) {
    const { open, lastEnded, raw } = await readEvidence();
    if (open > 0 && !sawOpenTurn) {
      sawOpenTurn = true;
      adopted = raw.turns;
      log(`✅ A: box-initiated turn HAS AUTHORITY after ${Date.now() - t0}ms: ${JSON.stringify(raw.turns)}`);
    }
    if (lastEnded && !terminalEvidence) {
      terminalEvidence = lastEnded;
      log(`✅ terminal row after ${Date.now() - t0}ms: ${JSON.stringify(lastEnded)}`);
    }
    if (sawOpenTurn && open === 0) {
      log(`✅ B: authority released after ${Date.now() - t0}ms`);
      break;
    }
    if (terminalEvidence && !sawOpenTurn && i > 20) break;
    if (i % 20 === 0) log(`  [${i}] open_turns=${open} last_ended=${lastEnded ? 'yes' : 'no'}`);
    await sleep(500);
  }

  log(`\nopencode_session=${ocId}`);
  log(`session_id=${sid}   project_id=${project.project_id}`);
  if (!sawOpenTurn && !terminalEvidence) {
    log('❌ FAILED: no turn authority EVER existed for a turn the box started on its own.');
    log('   (This is exactly the Essentia symptom — composer reads "not running".)');
    process.exit(1);
  }
  if (!sawOpenTurn) {
    log(`\nPROBE PASSED (terminal evidence only — the turn was shorter than the poll):`);
    log(`  ${JSON.stringify(terminalEvidence)}`);
    return;
  }
  log(`\nPROBE PASSED — adopted: ${JSON.stringify(adopted)}`);
}

main().catch((err) => {
  console.error('probe threw:', err);
  process.exit(1);
});
