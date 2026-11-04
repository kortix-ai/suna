/**
 * Real-Postgres contract of the shared channel webhook route
 * (`channelWebhookRoutes`), driven by a fake channel. The fake's body says
 * which events to store and which reply to send, so each case states its
 * input in the request. Mounted as app.ts mounts a channel: under a parent
 * whose onError is the global one (installHttpErrors).
 *
 * A BEFORE INSERT trigger on kortix.job_queue refuses the event id `fail`
 * while it is enabled and holds the event id `slow` for 300 ms.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { jobQueue } from '@kortix/db';
import { asc, like, sql } from 'drizzle-orm';
import { installHttpErrors } from '../../http-errors';
import { logger } from '../../lib/logger';
import { renderMetrics } from '../../lib/metrics';
import { runWithContext } from '../../lib/request-context';
import { makeOpenApiApp } from '../../openapi';
import { type AuditPrincipal, attachInboundAuditScope } from '../../shared/audit-scope';
import { db } from '../../shared/db';
import { type ChannelInbound, type InboundReply, safeEqual } from './inbound';
import { channelWebhookRoutes } from './webhook-routes';

const SECRET = 'fake-signing-secret';
/** Each run's rows carry their own install, so a rerun on the same database starts clean. */
const INSTALL = crypto.randomUUID();
const LIVE = crypto.randomUUID();
/** verify answers 404: no install. */
const UNKNOWN = crypto.randomUUID();
/** verify answers 200 and stores nothing: an install that is gone, which the platform must not retry. */
const GONE = crypto.randomUUID();
const sign = (raw: string) => createHmac('sha256', SECRET).update(raw).digest('hex');

let verifyCalls = 0;
const fakeInbound: ChannelInbound<{ projectId: string }> = {
  platform: 'fake',
  summary: 'Fake channel webhook (test only)',
  async verify({ projectId, header, rawBody }) {
    verifyCalls++;
    if (projectId === UNKNOWN) return { status: 404, body: { error: 'Not configured' } };
    if (projectId === GONE) return { status: 200, body: { ok: true, ignored: true } };
    if (!safeEqual(header('x-fake-signature') ?? '', sign(rawBody))) return { status: 401, body: { error: 'Invalid signature' } };
    return { verified: { projectId } };
  },
  async normalize(body, { projectId }) {
    const { events = [], reply } = body as { events?: string[]; reply?: InboundReply };
    return {
      events: events.map((id) => ({
        id,
        source: `fake:${INSTALL}`,
        type: 'fake.message.created',
        time: new Date(0).toISOString(),
        subject: null,
        projectId,
        data: {},
      })),
      reply,
    };
  },
};

const app = makeOpenApiApp();
app.route('/v1/webhooks/fake', channelWebhookRoutes(fakeInbound));
installHttpErrors(app);

const GLOBAL_500 = { error: true, message: 'Internal server error', status: 500 };
const errorLog = spyOn(logger, 'error');

/** The audit principal of the last `post()`. A request the route did not attribute leaves `{}`. */
let principal: AuditPrincipal = {};
/** A verified request is the fake channel acting on LIVE. */
const FAKE_ACTOR: AuditPrincipal = {
  projectId: LIVE,
  actorUserId: null,
  actorType: 'system',
  authoritativeSource: 'integration',
  authMethod: { kind: 'webhook_signature', provider: 'fake' },
};

/**
 * POST a raw body, signed with the fake's secret unless `signature` says otherwise.
 * The request runs in an open audit scope, as the server edge opens one, so the
 * route's principal bind is visible in `principal`.
 */
function post(raw: string | ReadableStream, opts: { projectId?: string; signature?: string; headers?: Record<string, string> } = {}) {
  const path = `/v1/webhooks/fake/${opts.projectId ?? LIVE}`;
  return runWithContext('POST', path, async () => {
    const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fake-signature': opts.signature ?? (typeof raw === 'string' ? sign(raw) : ''),
        ...opts.headers,
      },
      body: raw,
      ...(typeof raw === 'string' ? {} : { duplex: 'half' }),
    } as RequestInit);
    principal = scope.principal;
    return res;
  });
}

/** The event ids stored for this run, by job_key, with the queue and max_attempts of each row. */
async function stored(): Promise<Array<[string, string, number]>> {
  const rows = await db
    .select({ queue: jobQueue.queue, jobKey: jobQueue.jobKey, maxAttempts: jobQueue.maxAttempts })
    .from(jobQueue)
    .where(like(jobQueue.jobKey, `fake:${INSTALL}:%`))
    .orderBy(asc(jobQueue.jobKey));
  return rows.map((r) => [r.queue, r.jobKey.slice(`fake:${INSTALL}:`.length), r.maxAttempts]);
}
/** A stored row as `stored()` lists it: the fake's own queue and the default max_attempts. */
const row = (id: string): [string, string, number] => ['integration.events.fake', id, 8];

beforeAll(async () => {
  await db.execute(
    sql.raw(`create function kortix.channel_webhook_fake_store() returns trigger language plpgsql as $$ begin
      if new.job_key like 'fake:%:fail' then raise exception 'synthetic store failure'; end if;
      if new.job_key like 'fake:%:slow' then perform pg_sleep(0.3); end if;
      return new; end $$`),
  );
  await db.execute(
    sql.raw(`create trigger channel_webhook_fake_store before insert on kortix.job_queue
      for each row execute function kortix.channel_webhook_fake_store()`),
  );
});

beforeEach(() => {
  errorLog.mockClear();
  verifyCalls = 0;
});

afterAll(async () => {
  errorLog.mockRestore();
  await db.execute(sql.raw('drop trigger if exists channel_webhook_fake_store on kortix.job_queue'));
  await db.execute(sql.raw('drop function if exists kortix.channel_webhook_fake_store()'));
  await db.delete(jobQueue).where(like(jobQueue.jobKey, `fake:${INSTALL}:%`));
});

describe('channel webhook scaffold — migrated PostgreSQL', () => {
  test('a signature over the raw bytes verifies when the JSON body has irregular whitespace', async () => {
    const raw = '{ "events" :\n\t[ "spaced" ] ,  "pad":1 }';
    const res = await post(raw);
    expect({ status: res.status, body: await res.json(), rows: await stored(), principal }).toEqual({
      status: 200,
      body: { ok: true },
      rows: [row('spaced')],
      principal: FAKE_ACTOR,
    });
  });

  test.each([
    ['no install', { projectId: UNKNOWN }, 404, { error: 'Not configured' }],
    ['a wrong signature', { signature: sign('another body') }, 401, { error: 'Invalid signature' }],
    ['an install that is gone', { projectId: GONE }, 200, { ok: true, ignored: true }],
  ] as const)('verify answers %s: its reply goes out unchanged, nothing is stored and nobody is attributed', async (_name, opts, status, body) => {
    const res = await post(JSON.stringify({ events: ['refused'] }), opts);
    expect({ status: res.status, body: await res.json(), rows: await stored(), principal }).toEqual({
      status,
      body,
      rows: [row('spaced')],
      principal: {},
    });
  });

  test("normalize's reply goes out only after its row is stored", async () => {
    const res = await post(JSON.stringify({ events: ['slow'], reply: { status: 200, body: { type: 5 } } }));
    // Read before the body: the response itself must already prove the row.
    const rows = await stored();
    expect({ status: res.status, body: await res.json(), rows, principal }).toEqual({
      status: 200,
      body: { type: 5 },
      rows: [row('slow'), row('spaced')],
      principal: FAKE_ACTOR,
    });
  });

  test('a reply with a null body goes out as an empty 204', async () => {
    const res = await post(JSON.stringify({ reply: { status: 204, body: null } }));
    expect({ status: res.status, body: await res.text(), principal }).toEqual({ status: 204, body: '', principal: FAKE_ACTOR });
  });

  const oversize = JSON.stringify({ events: ['big'], pad: 'x'.repeat(1024 * 1024) });
  test.each([
    ['declared in content-length', () => post(oversize, { headers: { 'content-length': String(oversize.length) } })],
    [
      'streamed with no content-length',
      () =>
        post(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(oversize));
              controller.close();
            },
          }),
          { signature: sign(oversize) },
        ),
    ],
  ] as const)('a body over 1 MiB %s gets 413 before verify runs, and nobody is attributed', async (_name, send) => {
    const res = await send();
    expect({ status: res.status, body: await res.json(), verifyCalls, rows: await stored(), principal }).toEqual({
      status: 413,
      body: { error: 'Payload too large' },
      verifyCalls: 0,
      rows: [row('slow'), row('spaced')],
      principal: {},
    });
  });

  test('a verified body that is not JSON, sent as text/plain, gets 400 and is attributed', async () => {
    const res = await post('{', { headers: { 'content-type': 'text/plain' } });
    expect({ status: res.status, body: await res.json(), principal }).toEqual({
      status: 400,
      body: { error: 'Invalid JSON' },
      principal: FAKE_ACTOR,
    });
  });

  const twoEvents = JSON.stringify({ events: ['first', 'fail'], reply: { status: 200, body: { type: 5 } } });

  test('when the second store fails, the first row stays and the global 500 replaces the reply', async () => {
    const res = await post(twoEvents);
    expect({
      status: res.status,
      body: await res.json(),
      rows: await stored(),
      errorLines: errorLog.mock.calls.map(([line]) => line),
      principal,
    }).toEqual({
      status: 500,
      body: GLOBAL_500,
      rows: [row('first'), row('slow'), row('spaced')],
      errorLines: [`POST /v1/webhooks/fake/${LIVE} -> 500 [DB ERROR P0001]`],
      principal: FAKE_ACTOR,
    });
  });

  test('replays of that request store each event once', async () => {
    await db.execute(sql.raw('alter table kortix.job_queue disable trigger channel_webhook_fake_store'));
    const replies = [];
    for (let i = 0; i < 2; i++) {
      const res = await post(twoEvents);
      replies.push([res.status, await res.json()]);
    }
    expect({ replies, rows: await stored() }).toEqual({
      replies: [
        [200, { type: 5 }],
        [200, { type: 5 }],
      ],
      rows: [row('fail'), row('first'), row('slow'), row('spaced')],
    });
  });

  test('the request counter has one series per outcome and no id in a label', () => {
    const lines = renderMetrics()
      .split('\n')
      .filter((line) => line.startsWith('channel_webhook_requests_total{') && line.includes('platform="fake"'))
      .sort();
    expect(lines).toEqual([
      'channel_webhook_requests_total{outcome="accepted",platform="fake"} 3',
      'channel_webhook_requests_total{outcome="bad_request",platform="fake"} 1',
      'channel_webhook_requests_total{outcome="duplicate",platform="fake"} 1',
      'channel_webhook_requests_total{outcome="ignored",platform="fake"} 2',
      'channel_webhook_requests_total{outcome="rejected",platform="fake"} 2',
      'channel_webhook_requests_total{outcome="too_large",platform="fake"} 2',
    ]);
  });
});
