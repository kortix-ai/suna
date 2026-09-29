import { describe, expect, test } from 'bun:test';
import { blockedPath, canonicalPath, requestBodyShape, searchOperations, shapeTranscript, type Operation } from './shape';

// Real route shapes from the API's OpenAPI document, noise included: most
// project routes carry only the auto-generated "GET /:projectId/…" summary.
const CATALOG: Array<[string, string, string]> = [
  ['POST', '/v1/projects/{projectId}/secrets', 'POST /:projectId/secrets'],
  ['GET', '/v1/projects/{projectId}/secrets', 'GET /:projectId/secrets'],
  ['DELETE', '/v1/projects/{projectId}/secrets/{name}', 'DELETE /:projectId/secrets/:identifier'],
  ['GET', '/v1/runtime-assets/cli', 'GET /runtime-assets/cli — the `kortix` binary this deploy bakes into sandboxes'],
  ['GET', '/v1/runtime-assets/manifest', 'GET /runtime-assets/manifest — digests of this deploy runtime assets'],
  ['POST', '/v1/projects/{projectId}/triggers', 'POST /:projectId/triggers'],
  ['POST', '/v1/projects/{projectId}/triggers/{slug}/fire', 'POST /:projectId/triggers/:slug/fire'],
  ['POST', '/v1/billing/cron/trial-expiry', 'Sweep expired trials (cron)'],
  ['POST', '/v1/projects/create-repo', 'POST /create-repo'],
  ['POST', '/v1/projects', 'POST /'],
  ['POST', '/v1/projects/{projectId}/sessions/{sessionId}/stop', 'POST /:projectId/sessions/:sessionId/stop'],
  ['POST', '/v1/projects/{projectId}/apps/{appId}/stop', 'stop an App'],
  ['GET', '/v1/usage/session-costs', 'List session costs for one account'],
  ['POST', '/v1/projects/{projectId}/change-requests', 'POST /:projectId/change-requests'],
  ['POST', '/v1/projects/{projectId}/change-requests/{crId}/merge', 'POST /:projectId/change-requests/:crId/merge'],
  ['POST', '/v1/connectors/projects/{projectId}/call', 'Run a connector action in a project (any valid principal)'],
  ['GET', '/v1/connectors/projects/{projectId}/connectors', "List a project's connectors with status (dashboard)"],
  ['POST', '/v1/accounts/{accountId}/invites', 'POST /:accountId/invites'],
  ['POST', '/v1/accounts/{accountId}/branding/assets/{kind}', 'Upload a branding asset (logo, icon, or favicon)'],
  ['GET', '/v1/accounts/{accountId}/audit', 'List audit events (cursor-paginated)'],
  ['POST', '/v1/notifications/device-token', 'Register this device for push notifications'],
];
const OPS: Operation[] = CATALOG.map(([method, path, summary]) => ({ method, path, summary, description: '', tags: [], spec: {} }));
const top5 = (q: string) => searchOperations(OPS, q, 5).map((o) => `${o.method} ${o.path}`);

describe('searchOperations', () => {
  // Before: `a` matched every path and `set` matched `assets`, so these missed.
  const INTENTS: Array<[string, string]> = [
    ['set a secret', 'POST /v1/projects/{projectId}/secrets'],
    ['stop a session', 'POST /v1/projects/{projectId}/sessions/{sessionId}/stop'],
    ['create a cron trigger', 'POST /v1/projects/{projectId}/triggers'],
    ['fire a trigger', 'POST /v1/projects/{projectId}/triggers/{slug}/fire'],
    ['merge change request', 'POST /v1/projects/{projectId}/change-requests/{crId}/merge'],
    ['open a change request', 'POST /v1/projects/{projectId}/change-requests'],
    ['call a connector action', 'POST /v1/connectors/projects/{projectId}/call'],
    ['invite a member', 'POST /v1/accounts/{accountId}/invites'],
    ['audit log', 'GET /v1/accounts/{accountId}/audit'],
    ['list connectors', 'GET /v1/connectors/projects/{projectId}/connectors'],
  ];
  for (const [intent, want] of INTENTS) {
    test(`"${intent}" finds ${want} in the top 5`, () => expect(top5(intent)).toContain(want));
  }
  test('terms shorter than 3 letters and stopwords match nothing on their own', () => {
    expect(top5('a')).toEqual([]);
    expect(top5('the for and')).toEqual([]);
  });
  test('terms match whole words or prefixes, never a substring inside a word', () => {
    expect(top5('set').some((r) => r.includes('assets'))).toBe(false);
  });
});

describe('path guard', () => {
  const refused = (p: string) => {
    const c = canonicalPath(p);
    return c === null || !c.startsWith('/v1/') || blockedPath(c);
  };
  for (const p of [
    '/v1/oauth/grants',
    '/v1/projects/../oauth/grants',
    '/v1/%6fauth/grants',
    '/v1/projects/%2e%2e/oauth/grants',
    '/v1/%6dcp',
    '/v1//oauth/grants',
    '/v1/OAuth/grants',
    '/v1/x/../mcp?y=1',
    '/v1/%zz',
  ]) {
    test(`refuses ${p}`, () => expect(refused(p)).toBe(true));
  }
  test('allows an ordinary route', () => expect(refused('/v1/projects/abc/secrets?limit=1')).toBe(false));
});

describe('shapeTranscript', () => {
  const msg = (i: number, extra: Record<string, unknown> = {}) => ({ id: `m${i}`, role: i % 2 ? 'user' : 'assistant', text: 'x'.repeat(3000), ...extra });

  test('drops the OLDEST messages, keeps the newest, and always parses', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i));
    const out = shapeTranscript({ turn: 'idle' }, { source: 'live', messages, message_count: 30, complete: true });
    expect(out.length).toBeLessThanOrEqual(58_000);
    const parsed = JSON.parse(out);
    expect(parsed.messages.at(-1).id).toBe('m29');
    expect(parsed.omitted_older).toBeGreaterThan(0);
    expect(parsed.messages).toHaveLength(30 - parsed.omitted_older);
    expect(parsed.message_count).toBe(30);
  });
  test('a result that fits reports nothing omitted', () => {
    const parsed = JSON.parse(shapeTranscript({}, { source: 'live', messages: [msg(0)] }));
    expect(parsed.omitted_older).toBeUndefined();
  });
  test('error is name + message; last_turn_error is the newest assistant error; no header dump', () => {
    const error = { name: 'APIError', data: { message: 'requires a paid plan', statusCode: 400, responseHeaders: { 'cf-ray': 'x' }, responseBody: '{}' } };
    const parsed = JSON.parse(shapeTranscript({ error: null }, { messages: [msg(1), msg(2, { error })] }));
    expect(parsed.last_turn_error).toEqual({ name: 'APIError', message: 'requires a paid plan' });
    expect(parsed.messages[1].error).toEqual({ name: 'APIError', message: 'requires a paid plan' });
    expect(JSON.stringify(parsed)).not.toContain('responseHeaders');
    expect(JSON.parse(shapeTranscript({}, { messages: [msg(1)] })).last_turn_error).toBeNull();
  });
});

describe('requestBodyShape', () => {
  test('collapses the lenientBody fallback branch to the first branch plus additionalProperties: true', () => {
    const typed = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const shown = requestBodyShape({ content: { 'application/json': { schema: { anyOf: [typed, { type: 'object', additionalProperties: {} }] } } } });
    expect(shown).toEqual({ ...typed, additionalProperties: true });
  });
  test('a plain schema passes through; a non-JSON body prints its content type; none prints nothing', () => {
    const plain = { type: 'object', properties: { a: { type: 'string' } } };
    expect(requestBodyShape({ content: { 'application/json': { schema: plain } } })).toEqual(plain);
    expect(requestBodyShape({ content: { 'multipart/form-data': { schema: {} } } })).toEqual({ contentType: 'multipart/form-data' });
    expect(requestBodyShape(undefined)).toBeUndefined();
  });
});
