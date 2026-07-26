#!/usr/bin/env bun
/**
 * Provision a REAL Kortix session for the voice end-to-end test.
 *
 * Every voice test so far used a synthetic session id, which meant ask_kortix —
 * the whole point of the channel — could only ever report 'no-session'. This
 * mints a real user, project, and session with a live sandbox so the hand-off
 * has somewhere to land and the turn-relay has a turn to narrate.
 *
 * Prints `SESSION=<id> PROJECT=<id>` on success.
 */

const API = process.env.KE2E_API_URL || 'http://localhost:15608/v1';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;

async function j(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

async function main() {
  const stamp = Date.now();
  const email = `voice-e2e-${stamp}@example.test`;
  const password = `Voice-${stamp}!aA`;

  console.log('1/5  creating user…');
  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`user create failed: ${created.status} ${await created.text()}`);

  console.log('2/5  signing in…');
  const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const auth = await j(signIn);
  const token = auth?.access_token;
  if (!token) throw new Error(`sign-in failed: ${JSON.stringify(auth).slice(0, 300)}`);

  const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  console.log('3/5  creating project…');
  // /provision, not /projects: the plain create requires a BYO repo_url, while
  // provision mints a managed repo — the same path the e2e fixtures use.
  const projRes = await fetch(`${API}/projects/provision`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: `voice-e2e-${stamp}`, seed_starter: true }),
  });
  const proj = await j(projRes);
  const projectId = proj?.project_id ?? proj?.project?.project_id ?? proj?.id;
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(proj).slice(0, 400)}`);
  console.log(`     project ${projectId}`);

  // The voice channel is connector-backed and experimental-gated; without this
  // the kortix_voice connector never materializes and voice_spawn cannot join.
  console.log('4/5  enabling the voice experimental flag…');
  const flagRes = await fetch(`${API}/projects/${projectId}/experimental`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ feature: 'voice', enabled: true }),
  });
  console.log(`     ${flagRes.status} ${flagRes.ok ? 'enabled' : (await flagRes.text()).slice(0, 200)}`);

  console.log('5/5  creating session (boots a sandbox — takes ~20s)…');
  const sessRes = await fetch(`${API}/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ initial_prompt: 'Say hello and wait for instructions.' }),
  });
  const sess = await j(sessRes);
  const sessionId = sess?.session?.session_id ?? sess?.session_id ?? sess?.id;
  if (!sessionId) throw new Error(`session create failed: ${JSON.stringify(sess).slice(0, 500)}`);
  console.log(`     session ${sessionId}`);

  // Wait for the sandbox to be ready — continueSession polls for this too, but
  // failing here gives a far clearer error than a silent 'pending' later.
  for (let i = 0; i < 60; i++) {
    const s = await j(await fetch(`${API}/projects/${projectId}/sessions/${sessionId}`, { headers: H }));
    const stage = s?.session?.sandbox?.stage ?? s?.sandbox?.stage ?? s?.session?.status ?? s?.status;
    if (i % 5 === 0) console.log(`     …${stage}`);
    if (stage === 'ready' || stage === 'running') break;
    if (stage === 'failed') throw new Error('sandbox failed to boot');
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log('');
  console.log(`SESSION=${sessionId}`);
  console.log(`PROJECT=${projectId}`);
  console.log(`TOKEN=${token.slice(0, 12)}…`);
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
