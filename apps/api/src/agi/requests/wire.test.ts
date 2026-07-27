import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REQUEST_UNANSWERED_HOURS,
  REQUEST_FINGERPRINT_PREFIX,
  REQUEST_UNANSWERED_ENV_KEY,
  canonicalNeed,
  isDelivered,
  isLiveRequest,
  isRequestAnswerOverdue,
  isRequestKind,
  isRequestStatus,
  requestBody,
  requestFingerprint,
  requestHeadline,
  requestUnansweredForMs,
  resolveRequestUnansweredAfterMs,
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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The row above was delivered at 07:00:01. `now` is pinned in every call below
 *  rather than left to the real clock: with a fixture timestamp and a real
 *  `Date.now()`, "is this ask still live" would answer true today and false the
 *  day after tomorrow, and the suite would rot silently into always-stalled. */
const SOON = new Date('2026-07-27T08:00:00.000Z');
/** The fixture's delivery instant, named so the age arithmetic below reads as
 *  "this long after it reached them" rather than as an offset from nothing. */
const DELIVERED_AT = new Date('2026-07-27T07:00:01.000Z');
const live = (overrides: Partial<AgiRequestRow> = {}, now: Date = SOON) =>
  isLiveRequest(row(overrides), { now });

describe('isLiveRequest — R-12g', () => {
  test('pending AND delivered AND recent is a live path', () => {
    expect(live()).toBe(true);
  });

  test('recorded but never sent is NOT a live path — this is the whole point', () => {
    // A row with no delivery is the database-shaped version of writing the ask
    // into a session log. It must not make the task look healthy.
    expect(live({ deliveredAt: null, deliveredVia: null })).toBe(false);
  });

  test('a satisfied request stops propping the task up the moment it is answered', () => {
    expect(live({ status: 'satisfied', satisfiedAt: new Date('2026-07-27T09:00:00Z') })).toBe(false);
  });

  test('a cancelled request is not a live path either', () => {
    expect(live({ status: 'cancelled' })).toBe(false);
  });

  test('inbox delivery counts — a named person with a queue is a real surface', () => {
    expect(live({ deliveredVia: 'inbox' })).toBe(true);
  });

  // ─── the age term, and why the boolean above was not enough ───────────────
  //
  // Without it, ONE delivered row propped its task up as `awaiting_response`
  // forever: reproduced at 45 days unanswered on a board reporting
  // `stalled_count: 0`. On a fresh workspace the surface reached is `inbox` — a
  // row a human has to go looking for — and R-12g deliberately buys no second
  // nag, so nothing was ever going to change that answer.

  test('a delivery is an event, not a standing promise: past the window it is dead', () => {
    const fortyFiveDays = new Date(DELIVERED_AT.getTime() + 45 * DAY);
    expect(live({}, fortyFiveDays)).toBe(false);
    // Still PENDING and still DELIVERED — neither of the old halves changed. The
    // only thing that moved is the clock, which is exactly the point.
    expect(row().status).toBe('pending');
    expect(isDelivered(row())).toBe(true);
  });

  test('the window is inclusive at the boundary and configurable per call', () => {
    const at = new Date(DELIVERED_AT.getTime() + 6 * HOUR);
    expect(live({}, at)).toBe(true);
    expect(isLiveRequest(row(), { now: at, unansweredAfterMs: 6 * HOUR })).toBe(false);
    expect(isLiveRequest(row(), { now: at, unansweredAfterMs: 6 * HOUR + 1 })).toBe(true);
  });

  test('an ask nobody sent never ages — undelivered is its own failure', () => {
    // The two must stay distinguishable: one is fixed by delivering it, the
    // other by answering it, and `deliveredAt` is what tells them apart.
    const undelivered = row({ deliveredAt: null, deliveredVia: null, responderUserId: null });
    expect(
      isRequestAnswerOverdue({ deliveredAt: undelivered.deliveredAt, now: SOON, unansweredAfterMs: 1 }),
    ).toBe(false);
    expect(requestUnansweredForMs({ deliveredAt: undelivered.deliveredAt, now: SOON })).toBeNull();
  });

  test('the age is reported, and never negative', () => {
    const at = new Date(DELIVERED_AT.getTime() + 3 * DAY);
    expect(requestUnansweredForMs({ deliveredAt: row().deliveredAt, now: at })).toBe(3 * DAY);
    // Clock skew between the database and this process must not produce a
    // negative wait that reads as "delivered in the future".
    const before = new Date(DELIVERED_AT.getTime() - 5_000);
    expect(requestUnansweredForMs({ deliveredAt: row().deliveredAt, now: before })).toBe(0);
  });

  test('`live` on the wire is the aged verdict, so no caller re-implements it', () => {
    // The CLI, the UI and liveness all read this field. If it disagreed with the
    // stall surface, one of them would tell a human the task is fine.
    const stale = row({ deliveredAt: new Date(Date.now() - 90 * DAY) });
    expect(serializeAgiRequest(stale).live).toBe(false);
    expect(serializeAgiRequest(row({ deliveredAt: new Date() })).live).toBe(true);
  });
});

describe('resolveRequestUnansweredAfterMs', () => {
  test('the default is two days, in ms', () => {
    expect(resolveRequestUnansweredAfterMs({})).toBe(DEFAULT_REQUEST_UNANSWERED_HOURS * HOUR);
    expect(DEFAULT_REQUEST_UNANSWERED_HOURS).toBe(48);
  });

  test('the env override is stated in hours', () => {
    expect(resolveRequestUnansweredAfterMs({ [REQUEST_UNANSWERED_ENV_KEY]: ' 6 ' })).toBe(6 * HOUR);
  });

  test('a typo can never switch the detector off', () => {
    // `age >= NaN` is false for every age, which would make EVERY delivered ask
    // live forever — the exact defect this threshold closes, reintroduced by a
    // misspelling. Same for zero, in the opposite direction.
    for (const raw of ['', 'soon', '6h', '-1', '0', '1.5']) {
      expect(resolveRequestUnansweredAfterMs({ [REQUEST_UNANSWERED_ENV_KEY]: raw })).toBe(
        DEFAULT_REQUEST_UNANSWERED_HOURS * HOUR,
      );
    }
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
