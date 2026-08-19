/**
 * Integration test (REAL cloud sandbox): the contract the prompt inbox's
 * forward-immediately behaviour is built on.
 *
 * `admitInboxPrompt` used to refuse admission while the session held live turn
 * authority, because "delivering into a running turn is what OpenCode answers
 * by aborting the turn in progress". That belief was never pinned by anything —
 * only asserted in prose — and it is FALSE. OpenCode persists a mid-turn prompt
 * as a user message immediately and runs it in ARRIVAL order once the turn in
 * flight ends. This file is the pin: if it fails, the admission gate has to
 * come back.
 *
 * It spends real cloud compute and real model credits, so it is opt-in:
 *
 *   cd apps/api && KORTIX_REAL_SANDBOX_TESTS=1 \
 *     dotenvx run -- bun test --isolate src/__tests__/integration-inbox-midturn-forward.test.ts
 *
 * It needs the local stack up (`pnpm dev`): the sandbox reaches the control
 * plane back through the tunnel that script starts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';

const ENABLED = process.env.KORTIX_REAL_SANDBOX_TESTS === '1';
const API = process.env.KORTIX_MIDTURN_API_URL ?? 'http://localhost:8008';
const SUPABASE = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
/** A repo the sandbox can actually clone. Overridable so this can be pointed at
 *  a local bare repo served over HTTP, or at any small public repository. */
const REPO_URL =
  process.env.KORTIX_MIDTURN_REPO_URL ?? 'https://github.com/octocat/Hello-World.git';
const REPO_BRANCH = process.env.KORTIX_MIDTURN_REPO_BRANCH ?? 'master';

/** P1 has to still be running when P2 lands, so it is a real shell wait rather
 *  than a long piece of prose the model may finish in a second. */
const P1_TEXT =
  'Run this exact shell command and then report its final line: ' +
  '`for i in $(seq 1 12); do echo tick-$i; sleep 3; done`';
const P2_TEXT = 'Reply with exactly: SECOND-PROMPT-OK';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/**
 * The client's own minter, in one line: `msg_` + 12 hex clock chars + 14 base62.
 *
 * EXACTLY what the browser does (`ascendingId`, packages/sdk): the local clock,
 * scaled, with NO headroom and no lift against the session's newest id. Minting
 * P2 into the future would remove the very variable under test — whether a
 * mid-turn prompt is placed above the running turn's messages — and the test
 * would pass with that placement completely broken.
 */
function mintWireId(): string {
  const clock = (BigInt(Date.now()) * BigInt(0x1000)) & BigInt(0xffffffffffff);
  let suffix = '';
  for (let i = 0; i < 14; i++) suffix += BASE62[Math.floor(Math.random() * 62)];
  return `msg_${clock.toString(16).padStart(12, '0')}${suffix}`;
}

/** The clock half of a wire id — what OpenCode orders by. */
function wireClock(id: string): bigint {
  return BigInt(`0x${id.slice(4, 16)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface OpencodeMessage {
  info?: {
    id?: string;
    role?: string;
    parentID?: string;
    time?: { created?: number; completed?: number };
  };
}

let token = '';
let accountId = '';
let projectId = '';
let sessionId = '';
let externalId = '';
let rootSessionId = '';
function auth(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
}

async function createUser(): Promise<{ token: string; userId: string }> {
  const email = `midturn-${randomUUID()}@example.test`;
  const password = `Pw-${randomUUID()}`;
  const created = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`admin user create failed: ${created.status}`);
  const user = (await created.json()) as { id: string };

  const granted = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!granted.ok) throw new Error(`password grant failed: ${granted.status}`);
  const session = (await granted.json()) as { access_token: string };
  return { token: session.access_token, userId: user.id };
}

/** A project row pointing at a repo the sandbox can clone. Written straight to
 *  the database: `POST /projects/provision` is a managed-GitHub path this test
 *  has nothing to do with. */
async function createProject(userId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO kortix.projects
      (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
    VALUES (${id}::uuid, ${accountId}::uuid, 'midturn-forward-it', ${REPO_URL}, ${REPO_BRANCH},
            'kortix.yaml', 'active'::kortix.project_status, '{}'::jsonb)`);
  await db.execute(sql`
    INSERT INTO kortix.project_members (account_id, project_id, user_id, project_role, granted_by)
    VALUES (${accountId}::uuid, ${id}::uuid, ${userId}::uuid, 'manager'::kortix.project_role,
            ${userId}::uuid)`);
  return id;
}

async function startUntilReady(): Promise<void> {
  const deadline = Date.now() + 300_000;
  let last = '';
  while (Date.now() < deadline) {
    const response = await fetch(`${API}/v1/projects/${projectId}/sessions/${sessionId}/start`, {
      method: 'POST',
      headers: auth(),
      body: '{}',
    });
    const body = (await response.json()) as {
      stage?: string;
      reason?: string;
      opencode_session_id?: string;
      sandbox?: { external_id?: string };
    };
    last = `${body.stage}/${body.reason}`;
    if (body.sandbox?.external_id) externalId = body.sandbox.external_id;
    if (body.stage === 'ready' && body.opencode_session_id) {
      rootSessionId = body.opencode_session_id;
      return;
    }
    await sleep(5_000);
  }
  throw new Error(`session never reached ready (last: ${last})`);
}

async function postPrompt(text: string, wireId: string): Promise<Response> {
  return fetch(`${API}/v1/projects/${projectId}/sessions/${sessionId}/prompts`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      client_message_id: `cm-${wireId}`,
      message_id: wireId,
      parts: [{ type: 'text', text }],
    }),
  });
}

async function listPrompts(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${API}/v1/projects/${projectId}/sessions/${sessionId}/prompts`, {
    headers: auth(),
  });
  return ((await response.json()) as { prompts: Array<Record<string, unknown>> }).prompts;
}

async function readTurns(): Promise<Array<{ message_id: string; state: string }>> {
  const response = await fetch(`${API}/v1/projects/${projectId}/sessions/${sessionId}/turn`, {
    headers: auth(),
  });
  return ((await response.json()) as { turns: Array<{ message_id: string; state: string }> }).turns;
}

async function readMessages(): Promise<OpencodeMessage[]> {
  const response = await fetch(
    `${API}/v1/p/${externalId}/8000/session/${rootSessionId}/message?directory=%2Fworkspace`,
    { headers: auth() },
  );
  if (!response.ok) return [];
  const body = await response.json();
  return Array.isArray(body) ? (body as OpencodeMessage[]) : [];
}

async function ledgerTurn(
  messageId: string,
): Promise<{ state: string; end_reason: string } | null> {
  const result = await db.execute(sql`
    SELECT state, end_reason FROM kortix.session_turns
     WHERE session_id = ${sessionId} AND message_id = ${messageId}
     ORDER BY started_at DESC LIMIT 1`);
  const rows = ((result as { rows?: Array<Record<string, unknown>> }).rows ?? result) as Array<
    Record<string, unknown>
  >;
  return rows[0]
    ? { state: rows[0].state as string, end_reason: rows[0].end_reason as string }
    : null;
}

const P1_WIRE = mintWireId();
const P2_WIRE = mintWireId();
/**
 * The id P2 is actually DELIVERED under, read back from the inbox row.
 *
 * It is not `P2_WIRE`. A prompt posted into a live turn is re-minted by the
 * drain before it goes out (`executeQueuedContinue`), because the client's id
 * is its browser's clock and the running turn has been writing higher ids ever
 * since it started. Everything downstream — the persisted user message, the
 * ledger turn, the inbox row — names this one.
 */
let p2Delivered = '';

/** The id the inbox says this submission went out under, once it has. */
async function deliveredIdFor(clientMessageId: string): Promise<string> {
  const row = (await listPrompts()).find((r) => r.client_message_id === clientMessageId);
  const id = row?.message_id;
  return typeof id === 'string' ? id : '';
}

beforeAll(async () => {
  if (!ENABLED) return;
  const user = await createUser();
  token = user.token;
  // The API creates the personal account on the first authenticated call.
  const accounts = await fetch(`${API}/v1/accounts`, { headers: auth() });
  accountId = ((await accounts.json()) as Array<{ account_id: string }>)[0].account_id;
  // A real turn needs a model this account may actually run, and the free tier
  // may run none. Both facts are billing fixtures, not the behaviour under test.
  await db.execute(sql`
    UPDATE kortix.credit_accounts
       SET balance = 100, managed_models_override = true
     WHERE account_id = ${accountId}::uuid`);

  projectId = await createProject(user.userId);
  const created = await fetch(`${API}/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: auth(),
    body: '{}',
  });
  sessionId = ((await created.json()) as { session_id: string }).session_id;
  await startUntilReady();
}, 420_000);

afterAll(async () => {
  if (!ENABLED || !sessionId) return;
  await fetch(`${API}/v1/projects/${projectId}/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: auth(),
  }).catch(() => undefined);
}, 120_000);

describe.if(ENABLED)('a prompt posted MID-TURN reaches OpenCode', () => {
  test('P1 opens a turn', async () => {
    const response = await postPrompt(P1_TEXT, P1_WIRE);
    expect(response.status).toBe(202);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if ((await readTurns()).some((turn) => turn.message_id === P1_WIRE)) return;
      await sleep(1_000);
    }
    throw new Error('P1 never opened a turn');
  }, 120_000);

  test('P2 posted into that turn is FORWARDED, persisted, and queued', async () => {
    // Far enough into P1's tool call that "the turn is running" is not a race.
    await sleep(8_000);
    const before = await readMessages();
    expect(
      before.some((m) => m.info?.parentID === P1_WIRE && m.info?.time?.completed === undefined),
    ).toBe(true);

    const started = Date.now();
    const response = await postPrompt(P2_TEXT, P2_WIRE);
    expect(response.status).toBe(202);

    // 1. It reaches OpenCode WITHOUT waiting for the turn. The bound is the
    //    drain's own round trip — claim, openSession, transcript read, re-mint,
    //    proxy POST, measured at ~4s locally — not the turn, which has ~30s
    //    left to run. The old gate would have parked this row until the turn
    //    ended.
    let persisted = false;
    let persistedAfterMs = 0;
    while (Date.now() - started < 20_000 && !persisted) {
      p2Delivered = (await deliveredIdFor(`cm-${P2_WIRE}`)) || p2Delivered;
      persisted =
        !!p2Delivered &&
        (await readMessages()).some(
          (m) => m.info?.id === p2Delivered && m.info?.role === 'user',
        );
      persistedAfterMs = Date.now() - started;
      if (!persisted) await sleep(250);
    }
    expect(persisted).toBe(true);

    // 2. And it landed MID-TURN: P1's assistant message is still open, so P2
    //    was not admitted into an idle session by a lucky race.
    const during = await readMessages();
    const p1Assistant = during.find((m) => m.info?.parentID === P1_WIRE);
    expect(p1Assistant?.info?.time?.completed).toBeUndefined();
    expect(persistedAfterMs).toBeLessThan(20_000);

    // 3. IT WAS PLACED ABOVE THE RUNNING TURN. This is the whole risk of
    //    forwarding mid-turn: OpenCode resolves "already answered?" by id
    //    order, so an id below the turn's own messages is accepted and then
    //    silently never runs, with no assistant message and nothing to
    //    redeliver from. The client's id carries no lift, so the drain re-mints
    //    against the transcript — and that is what this compares.
    const p1AssistantId = p1Assistant?.info?.id;
    expect(typeof p1AssistantId).toBe('string');
    expect(wireClock(p2Delivered)).toBeGreaterThan(wireClock(p1AssistantId as string));

    // 4. The control plane opened a turn for P2 while P1's was still running.
    //    Only P2 is asserted: the daemon's message-scoped probe reads "a newer
    //    user message owns the root" as terminal, so a reaper pass inside this
    //    window can close P1's record early — see the residual documented on
    //    the last test in this file.
    expect((await readTurns()).map((turn) => turn.message_id)).toContain(p2Delivered);

    // 5. The inbox row says DELIVERING, not waiting: forwarded, and open until
    //    the ledger confirms a turn consumed it.
    const rows = await listPrompts();
    const p2Row = rows.find((r) => r.message_id === p2Delivered);
    expect(p2Row?.state).toBe('delivering');
    expect(p2Row?.reason).toBe('forwarded');
  }, 180_000);

  test('P2 runs after P1 finishes, and both inbox rows close on the ledger', async () => {
    const deadline = Date.now() + 240_000;
    let p1Created: number | undefined;
    let p1Done: number | undefined;
    let p2Created: number | undefined;
    while (Date.now() < deadline) {
      const messages = await readMessages();
      const p1Assistant = messages.find((m) => m.info?.parentID === P1_WIRE);
      p1Created = p1Assistant?.info?.time?.created;
      p1Done = p1Assistant?.info?.time?.completed;
      // OPENED, not completed. Two completion timestamps cannot separate
      // "arrival order" from "P2 aborted P1": an abort stamps P1 completed too,
      // and P2's own answer still finishes after it. When P2's assistant was
      // CREATED is the fact that distinguishes them.
      p2Created = messages.find((m) => m.info?.parentID === p2Delivered)?.info?.time?.created;
      if (p1Done && p2Created) break;
      await sleep(3_000);
    }

    // P1 RAN TO COMPLETION. Its prompt is a deterministic 12 x 3s shell loop
    // and P2 landed ~12s in, so an OpenCode that answered the mid-turn arrival
    // by aborting would leave a P1 assistant message far shorter than the loop.
    // This is the assertion the file exists for: if it fails, the admission
    // gate has to come back.
    expect(p1Created).toBeGreaterThan(0);
    expect(p1Done).toBeGreaterThan(0);
    expect((p1Done as number) - (p1Created as number)).toBeGreaterThanOrEqual(30_000);

    // ARRIVAL ORDER: P2's turn OPENED after P1's closed. It waited for the turn
    // in front of it rather than interrupting it.
    expect(p2Created).toBeGreaterThanOrEqual(p1Done as number);

    // The ledger records P2's turn as a turn that RAN. POLLED, not read once:
    // the settle is driven by the daemon's `turn_end` callback, which lands
    // after the assistant message it describes.
    const ledgerDeadline = Date.now() + 60_000;
    let turn = await ledgerTurn(p2Delivered);
    while (turn?.state !== 'ended' && Date.now() < ledgerDeadline) {
      await sleep(2_000);
      turn = await ledgerTurn(p2Delivered);
    }
    expect(turn?.state).toBe('ended');
    expect(['completed', 'failed']).toContain(turn?.end_reason ?? 'none');

    // And that is what closes P2's inbox row: a forwarded row lives until a
    // turn provably consumed its wire id.
    const deadlineRows = Date.now() + 90_000;
    let p2Row = (await listPrompts()).find((r) => r.message_id === p2Delivered);
    while (p2Row && Date.now() < deadlineRows) {
      await sleep(2_000);
      p2Row = (await listPrompts()).find((r) => r.message_id === p2Delivered);
    }
    expect(p2Row).toBeUndefined();

    // MEASURED RESIDUAL, asserted so it stays measured. Once P2's user message
    // exists, the daemon answers "is P1's turn in flight?" with NO — its rule
    // is that a newer user message owns the root — so a reaper pass inside P1's
    // remaining runtime closes P1's ledger row early, with a never-ran reason.
    // What must NEVER follow from that is a redelivery: P1 ran, and running it
    // again would spend a second real turn on the user's message. The reaper
    // only redelivers on `orphanedPrompt`, which needs NO assistant message at
    // all — and P1 has one.
    const messages = await readMessages();
    expect(messages.filter((m) => m.info?.id === P1_WIRE)).toHaveLength(1);
    expect(messages.filter((m) => m.info?.parentID === P1_WIRE)).toHaveLength(1);
  }, 300_000);
});

if (!ENABLED) {
  test('skipped: set KORTIX_REAL_SANDBOX_TESTS=1 to run the mid-turn forward gate', () => {
    // Loud on purpose. This file is the only proof that forwarding a prompt
    // into a live turn is safe, and a silent skip would let that belief rot.
    expect(ENABLED).toBe(false);
  });
}
