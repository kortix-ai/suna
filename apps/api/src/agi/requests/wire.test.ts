import { describe, expect, test } from 'bun:test';
import {
  canonicalNeed,
  isLiveRequest,
  isRequestKind,
  isRequestStatus,
  REQUEST_FINGERPRINT_PREFIX,
  requestBody,
  requestFingerprint,
  requestHeadline,
  serializeAgiRequest,
  type AgiRequestRow,
} from './wire';
import { parseCreateRequestBody, parseResolveRequestBody } from './input';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';

function row(overrides: Partial<AgiRequestRow> = {}): AgiRequestRow {
  return {
    requestId: REQUEST_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    kind: 'secret',
    need: 'GOOGLE_SEARCH_CONSOLE_TOKEN',
    why: 'The SEO push cannot read rankings without it.',
    url: 'https://app.kortix.test/setup/abc',
    responderUserId: USER_ID,
    status: 'pending',
    deliveredAt: new Date('2026-07-27T07:00:01.000Z'),
    deliveredVia: 'slack',
    requestedBySessionId: 'ses_push',
    originFingerprint: `${REQUEST_FINGERPRINT_PREFIX}:deadbeef`,
    satisfiedAt: null,
    satisfiedByUserId: null,
    createdAt: new Date('2026-07-27T07:00:00.000Z'),
    updatedAt: new Date('2026-07-27T07:00:01.000Z'),
    ...overrides,
  } as AgiRequestRow;
}

describe('vocabularies', () => {
  test('the four kinds are the four things that actually stop an unattended run', () => {
    for (const kind of ['secret', 'connector', 'access', 'decision']) {
      expect(isRequestKind(kind)).toBe(true);
    }
    expect(isRequestKind('approval')).toBe(false);
    expect(isRequestKind(null)).toBe(false);
  });

  test('statuses are pending, satisfied, cancelled — and nothing reopens', () => {
    expect(isRequestStatus('pending')).toBe(true);
    expect(isRequestStatus('satisfied')).toBe(true);
    expect(isRequestStatus('cancelled')).toBe(true);
    expect(isRequestStatus('reopened')).toBe(false);
  });
});

// ─── The one boolean the whole feature turns on ─────────────────────────────

describe('isLiveRequest — R-12g', () => {
  test('pending AND delivered is a live path', () => {
    expect(isLiveRequest(row())).toBe(true);
  });

  test('recorded but never sent is NOT a live path — this is the whole point', () => {
    // A row with no delivery is the database-shaped version of writing the ask
    // into a session log. It must not make the task look healthy.
    expect(isLiveRequest(row({ deliveredAt: null, deliveredVia: null }))).toBe(false);
  });

  test('a satisfied request stops propping the task up the moment it is answered', () => {
    expect(
      isLiveRequest(row({ status: 'satisfied', satisfiedAt: new Date('2026-07-27T09:00:00Z') })),
    ).toBe(false);
  });

  test('a cancelled request is not a live path either', () => {
    expect(isLiveRequest(row({ status: 'cancelled' }))).toBe(false);
  });

  test('inbox delivery counts — a named person with a queue is a real surface', () => {
    expect(isLiveRequest(row({ deliveredVia: 'inbox' }))).toBe(true);
  });
});

// ─── R-20 applied to asking a human ─────────────────────────────────────────

describe('requestFingerprint', () => {
  const base = { taskId: TASK_ID, kind: 'secret' as const, need: 'Search Console access' };

  test('the same ask twice is the same string', () => {
    expect(requestFingerprint(base)).toBe(requestFingerprint(base));
    expect(requestFingerprint(base).startsWith(`${REQUEST_FINGERPRINT_PREFIX}:`)).toBe(true);
  });

  test('a daily push re-asking in different casing or spacing is still ONE ask', () => {
    // This is what stops the human being direct-messaged every morning until
    // they mute the bot.
    expect(requestFingerprint({ ...base, need: '  search console ACCESS  ' })).toBe(
      requestFingerprint(base),
    );
  });

  test('a different task, kind, or need is a different ask', () => {
    expect(requestFingerprint({ ...base, taskId: REQUEST_ID })).not.toBe(requestFingerprint(base));
    expect(requestFingerprint({ ...base, kind: 'access' })).not.toBe(requestFingerprint(base));
    expect(requestFingerprint({ ...base, need: 'Ahrefs API key' })).not.toBe(
      requestFingerprint(base),
    );
  });

  test('canonicalNeed folds case and whitespace but never the stored wording', () => {
    expect(canonicalNeed('  Google   Search\nConsole ')).toBe('google search console');
  });
});

// ─── the message a human actually receives ──────────────────────────────────

describe('requestHeadline / requestBody', () => {
  test('a decision reads as a decision, everything else as access', () => {
    expect(requestHeadline({ kind: 'decision', need: 'Pick a broker' })).toBe(
      'Kortix needs a decision: Pick a broker',
    );
    expect(requestHeadline({ kind: 'secret', need: 'AHREFS_API_KEY' })).toBe(
      'Kortix needs access: AHREFS_API_KEY',
    );
  });

  test('the body names the blocked work, the session, and the link to click', () => {
    const body = requestBody({
      kind: 'secret',
      need: 'AHREFS_API_KEY',
      why: 'Cannot read rankings.',
      url: 'https://app.kortix.test/setup/abc',
      taskId: TASK_ID,
      taskTitle: 'Measure the core terms',
      sessionId: 'ses_push',
    });
    expect(body).toContain('Cannot read rankings.');
    expect(body).toContain('Measure the core terms');
    expect(body).toContain(TASK_ID);
    expect(body).toContain('ses_push');
    expect(body).toContain('https://app.kortix.test/setup/abc');
  });

  test('a credential ask tells the human NOT to paste it in a reply', () => {
    // The minted form is the only channel a secret may travel on. Saying it on
    // the human's side is what stops a helpful reply putting a live key in a
    // Slack DM the agent can read.
    const body = requestBody({
      kind: 'secret',
      need: 'AHREFS_API_KEY',
      why: null,
      url: 'https://app.kortix.test/setup/abc',
      taskId: TASK_ID,
      taskTitle: 'Measure the core terms',
      sessionId: null,
    });
    expect(body).toContain('never paste it in a reply');
  });

  test('a decision carries no paste warning — there is nothing secret to paste', () => {
    const body = requestBody({
      kind: 'decision',
      need: 'Pick a broker',
      why: null,
      url: 'https://app.kortix.test/decisions/1',
      taskId: TASK_ID,
      taskTitle: 'Choose execution venue',
      sessionId: null,
    });
    expect(body).not.toContain('never paste it in a reply');
  });
});

describe('serializeAgiRequest', () => {
  test('the wire shape is snake_case and derives `live` so no caller re-implements it', () => {
    expect(serializeAgiRequest(row())).toEqual({
      request_id: REQUEST_ID,
      workspace_id: WORKSPACE_ID,
      task_id: TASK_ID,
      kind: 'secret',
      need: 'GOOGLE_SEARCH_CONSOLE_TOKEN',
      why: 'The SEO push cannot read rankings without it.',
      url: 'https://app.kortix.test/setup/abc',
      responder_user_id: USER_ID,
      status: 'pending',
      delivered_at: '2026-07-27T07:00:01.000Z',
      delivered_via: 'slack',
      live: true,
      requested_by_session_id: 'ses_push',
      origin_fingerprint: `${REQUEST_FINGERPRINT_PREFIX}:deadbeef`,
      satisfied_at: null,
      satisfied_by_user_id: null,
      created_at: '2026-07-27T07:00:00.000Z',
      updated_at: '2026-07-27T07:00:01.000Z',
    });
  });

  test('an undelivered request serializes as not live', () => {
    const serialized = serializeAgiRequest(row({ deliveredAt: null, deliveredVia: null }));
    expect(serialized.delivered_at).toBeNull();
    expect(serialized.live).toBe(false);
  });

  test('there is no field on the wire that could carry a credential', () => {
    // The table has no value column and never may have one; this asserts the
    // serializer cannot grow one by accident.
    expect(Object.keys(serializeAgiRequest(row()))).not.toContain('value');
    expect(Object.keys(serializeAgiRequest(row()))).not.toContain('secret');
  });
});

// ─── input validation ───────────────────────────────────────────────────────

describe('parseCreateRequestBody', () => {
  const ok = { kind: 'secret', need: 'AHREFS_API_KEY' };

  test('a minimal ask parses, and idempotency is left for the route to derive', () => {
    const parsed = parseCreateRequestBody(ok);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.need).toBe('AHREFS_API_KEY');
    expect(parsed.value.originFingerprint).toBeNull();
    expect(parsed.value.responderUserId).toBeNull();
  });

  test('kind is closed — an invented one is a 400, not a silent default', () => {
    const parsed = parseCreateRequestBody({ kind: 'approval', need: 'x' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.error).toContain('kind must be');
  });

  test('an empty or whitespace need is rejected', () => {
    expect(parseCreateRequestBody({ kind: 'secret', need: '   ' }).ok).toBe(false);
    expect(parseCreateRequestBody({ kind: 'secret' }).ok).toBe(false);
  });

  test('a need past the column limit is a 400, never a 23514', () => {
    const parsed = parseCreateRequestBody({ kind: 'secret', need: 'x'.repeat(501) });
    expect(parsed.ok).toBe(false);
  });

  test('the url must be an http(s) LINK — a pasted credential cannot be stored', () => {
    // The security control. `url` is the one free-form field an agent fills in,
    // and the failure it guards is an agent that pasted the key itself here,
    // which would then be direct-messaged to a human in plain text.
    for (const bad of ['sk-live-abc123', 'ghp_deadbeef', 'javascript:alert(1)', 'file:///etc/passwd']) {
      const parsed = parseCreateRequestBody({ ...ok, url: bad });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error.code).toBe('invalid_url');
    }
  });

  test('an https link is accepted and kept verbatim', () => {
    const parsed = parseCreateRequestBody({ ...ok, url: 'https://app.kortix.test/setup/abc' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.url).toBe('https://app.kortix.test/setup/abc');
  });

  test('an empty url string means no url, not an invalid one', () => {
    const parsed = parseCreateRequestBody({ ...ok, url: '  ' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.url).toBeNull();
  });

  test('a responder must look like a user id', () => {
    expect(parseCreateRequestBody({ ...ok, responder_user_id: 'marko' }).ok).toBe(false);
    const parsed = parseCreateRequestBody({ ...ok, responder_user_id: USER_ID });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.responderUserId).toBe(USER_ID);
  });

  test('why is preserved byte for byte — its line breaks are what a human reads', () => {
    const parsed = parseCreateRequestBody({ ...ok, why: 'line one\n\nline two' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.why).toBe('line one\n\nline two');
  });
});

describe('parseResolveRequestBody', () => {
  test('satisfied is the default — the ordinary close is "the human did it"', () => {
    const parsed = parseResolveRequestBody({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.status).toBe('satisfied');
  });

  test('cancelled is the other way out, and nothing reopens', () => {
    expect(parseResolveRequestBody({ status: 'cancelled' }).ok).toBe(true);
    expect(parseResolveRequestBody({ status: 'pending' }).ok).toBe(false);
  });

  test('a note is optional and trimmed to null when empty', () => {
    const parsed = parseResolveRequestBody({ note: '   ' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.note).toBeNull();
  });
});
