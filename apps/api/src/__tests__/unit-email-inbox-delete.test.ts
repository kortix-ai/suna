import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { config } from '../config';

/**
 * Disconnecting an email inbox deletes on Resend what Kortix created (a
 * disconnected inbox must not keep billing) and never an inbox the person
 * attached. Resend's 404 is done; any other failure throws so the route keeps
 * the install.
 */

let ownKey: string | null = null;
let accounts: Array<{ connectionId: string; webhookId: string | null }> = [];
const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  emailOwnKeyForAccount: async () => ownKey,
  listEmailInboxAccounts: async () => accounts,
}));
const { deleteEmailInbox } = await import('../channels/email/inbox-delete');

const realFetch = globalThis.fetch;
let calls: Array<{ method: string; path: string; auth: string | null }> = [];
let status = 200;
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});
beforeEach(() => {
  ownKey = null;
  accounts = [];
  calls = [];
  status = 200;
  (config as { RESEND_API_KEY: string | undefined }).RESEND_API_KEY = 're_managed';
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({
      method: init?.method ?? 'GET',
      path: new URL(String(url)).pathname,
      auth: new Headers(init?.headers).get('authorization'),
    });
    return new Response(JSON.stringify(status === 200 ? { deleted: true } : { message: 'nope' }), { status });
  }) as any;
});

function install(over: Partial<{ createdByKortix: boolean; webhookId: string | null }> = {}) {
  return {
    connectionId: 'conn-1',
    connectorId: 'conn-email',
    projectId: 'proj-1',
    inboxId: 'inb-1',
    email: 'agent@kortixmail.com',
    displayName: null,
    label: 'agent@kortixmail.com',
    ownerType: 'project' as const,
    ownerId: null,
    isDefault: true,
    managed: true,
    webhookId: 'wh-1',
    senderPolicy: { mode: 'allow_all' as const, allowedEmails: [], allowedDomains: [], allowedRegex: null },
    agentName: null,
    createdByKortix: true,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('deleteEmailInbox', () => {
  test('a managed inbox Kortix created is deleted with the managed key; the shared managed webhook stays', async () => {
    await deleteEmailInbox(install());
    expect(calls).toEqual([{ method: 'DELETE', path: '/inboxes/inb-1', auth: 'Bearer re_managed' }]);
  });

  test('an own-key inbox Kortix created is deleted with that key, and its webhook when no other inbox uses it', async () => {
    ownKey = 're_own';
    accounts = [{ connectionId: 'conn-1', webhookId: 'wh-1' }];
    await deleteEmailInbox(install());
    expect(calls).toEqual([
      { method: 'DELETE', path: '/inboxes/inb-1', auth: 'Bearer re_own' },
      { method: 'DELETE', path: '/webhooks/wh-1', auth: 'Bearer re_own' },
    ]);
  });

  test('the own-key webhook stays while another inbox of the project still uses it', async () => {
    ownKey = 're_own';
    accounts = [
      { connectionId: 'conn-1', webhookId: 'wh-1' },
      { connectionId: 'conn-2', webhookId: 'wh-1' },
    ];
    await deleteEmailInbox(install());
    expect(calls.map((c) => c.path)).toEqual(['/inboxes/inb-1']);
  });

  test('an inbox the person attached by id is only unlinked: nothing is deleted on Resend', async () => {
    await deleteEmailInbox(install({ createdByKortix: false, webhookId: null }));
    expect(calls).toEqual([]);
  });

  test('Resend 404 (already gone) counts as done', async () => {
    status = 404;
    await deleteEmailInbox(install());
    expect(calls).toHaveLength(1);
  });

  test('any other Resend failure throws, so the install is kept', async () => {
    status = 500;
    await expect(deleteEmailInbox(install())).rejects.toMatchObject({ status: 500 });
  });
});
