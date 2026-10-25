import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  deadTunnelWebhookCandidates,
  ensureResendInboxWebhook,
  setTunnelProbeForTest,
} from '../channels/resend-email-api';

/**
 * A local stack reaches Resend through a quick tunnel whose URL changes on
 * every start, and each start adds a team-wide webhook. Ensuring this stack's
 * webhook also deletes the ones whose tunnel no longer answers, and never a
 * webhook on any other host: dev, staging and prod share Kortix's team.
 */

const OWN = 'https://own-tunnel.trycloudflare.com/v1/webhooks/email/resend';
const hooks = [
  { id: 'own', endpoint: OWN, events: ['inbox.email.received'], signing_secret: 'whsec_own' },
  { id: 'dead', endpoint: 'https://dead-tunnel.trycloudflare.com/v1/webhooks/email/resend', events: ['inbox.email.received'] },
  { id: 'alive', endpoint: 'https://alive-tunnel.trycloudflare.com/v1/webhooks/email/resend', events: ['inbox.email.received'] },
  { id: 'prod', endpoint: 'https://api.kortix.com/v1/webhooks/email/resend', events: ['inbox.email.received'] },
  { id: 'other-path', endpoint: 'https://x.trycloudflare.com/v1/webhooks/other', events: ['inbox.email.received'] },
];

const realFetch = globalThis.fetch;
let deleted: string[] = [];
beforeEach(() => {
  deleted = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    if ((init?.method ?? 'GET') === 'DELETE') {
      deleted.push(path.split('/').pop()!);
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: hooks }), { status: 200 });
  }) as any;
  setTunnelProbeForTest(async (origin) => origin.includes('alive-tunnel'));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  setTunnelProbeForTest(null);
});

describe('stale tunnel webhooks', () => {
  test('only other tunnel hooks on the email path are candidates', () => {
    expect(deadTunnelWebhookCandidates(hooks, OWN).map((h) => h.id)).toEqual(['dead', 'alive']);
  });

  test('ensuring this stack webhook deletes the dead tunnel hook, keeps the live one and every other host', async () => {
    const hook = await ensureResendInboxWebhook('re_test', OWN);
    expect(hook).toEqual({ id: 'own', signing_secret: 'whsec_own' });
    expect(deleted).toEqual(['dead']);
  });
});
