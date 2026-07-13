import { test, expect, beforeEach, mock } from 'bun:test';
import * as realAuth from '../../http/auth';

// This file must be hermetic against process-wide `mock.module('../../http/auth', ...)`
// registrations made by OTHER test files (see the identical comment in
// `./shared.test.ts` — bun's `mock.module` is process-wide/permanent for the
// whole `bun test` sweep). Register our OWN mock — a thin passthrough to
// `globalThis.fetch` this file fully controls — instead of depending on
// whichever OTHER file's registration happens to be resident, and import
// `./invites` via `await import(...)` so it resolves against THIS mock
// regardless of load order.
mock.module('../../http/auth', () => ({
  ...realAuth,
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input as any, init),
}));

const { getInvite, acceptInvite, declineInvite } = await import('./invites');
const { configureKortix } = await import('../../http/config');

let calls: { url: string; method: string }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  delete process.env.BACKEND_URL;
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok' });
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const last = () => calls[calls.length - 1];

// ─── getInvite ───────────────────────────────────────────────────────────────

test('getInvite GETs the invite route and returns result.data on success', async () => {
  const invite = {
    invite_id: 'inv-1',
    sandbox_id: 'sbx-1',
    sandbox_name: 'My Sandbox',
    email: 'a@b.com',
    inviter_email: 'owner@b.com',
    created_at: '2026-01-01T00:00:00Z',
    expires_at: '2026-02-01T00:00:00Z',
    accepted_at: null,
    email_matches_caller: true as const,
    expired: false,
  };
  nextResponse = { status: 200, body: { success: true, data: invite } };

  const result = await getInvite('inv-1');

  expect(last().url).toContain('/platform/invites/inv-1');
  expect(last().method).toBe('GET');
  expect(result).toEqual(invite);
});

test('getInvite throws result.error when the platform reports failure', async () => {
  nextResponse = { status: 200, body: { success: false, error: 'Invite expired' } };
  await expect(getInvite('inv-1')).rejects.toThrow('Invite expired');
});

test('getInvite falls back to "Invite not found" when success is true but data is missing', async () => {
  nextResponse = { status: 200, body: { success: true } };
  await expect(getInvite('inv-1')).rejects.toThrow('Invite not found');
});

// ─── acceptInvite ────────────────────────────────────────────────────────────

test('acceptInvite POSTs to the accept route and returns result.data on success', async () => {
  nextResponse = { status: 200, body: { success: true, data: { status: 'accepted', sandbox_id: 'sbx-1' } } };

  const result = await acceptInvite('inv-1');

  expect(last().url).toContain('/platform/invites/inv-1/accept');
  expect(last().method).toBe('POST');
  expect(result).toEqual({ status: 'accepted', sandbox_id: 'sbx-1' });
});

test('acceptInvite throws result.error when the platform reports failure', async () => {
  nextResponse = { status: 200, body: { success: false, error: 'Invite already accepted' } };
  await expect(acceptInvite('inv-1')).rejects.toThrow('Invite already accepted');
});

test('acceptInvite falls back to "Failed to accept invite" when success is true but data is missing', async () => {
  nextResponse = { status: 200, body: { success: true } };
  await expect(acceptInvite('inv-1')).rejects.toThrow('Failed to accept invite');
});

// ─── declineInvite ───────────────────────────────────────────────────────────

test('declineInvite POSTs to the decline route and resolves void on success (no data required)', async () => {
  nextResponse = { status: 200, body: { success: true } };

  const result = await declineInvite('inv-1');

  expect(last().url).toContain('/platform/invites/inv-1/decline');
  expect(last().method).toBe('POST');
  expect(result).toBeUndefined();
});

test('declineInvite throws result.error when the platform reports failure', async () => {
  nextResponse = { status: 200, body: { success: false, error: 'Invite already declined' } };
  await expect(declineInvite('inv-1')).rejects.toThrow('Invite already declined');
});

test('declineInvite falls back to "Failed to decline invite" when there is no error message', async () => {
  nextResponse = { status: 200, body: { success: false } };
  await expect(declineInvite('inv-1')).rejects.toThrow('Failed to decline invite');
});

// ─── URL encoding ────────────────────────────────────────────────────────────

test('encodeURIComponent is applied to the invite id for all three endpoints', async () => {
  const weirdId = 'inv/with space&stuff';
  nextResponse = { status: 200, body: { success: true, data: { invite_id: weirdId } } };
  await getInvite(weirdId).catch(() => {});
  expect(last().url).toContain(`/platform/invites/${encodeURIComponent(weirdId)}`);
  expect(last().url).not.toContain('inv/with space&stuff');

  nextResponse = { status: 200, body: { success: true, data: { status: 'accepted', sandbox_id: 'sbx-1' } } };
  await acceptInvite(weirdId);
  expect(last().url).toContain(`/platform/invites/${encodeURIComponent(weirdId)}/accept`);

  nextResponse = { status: 200, body: { success: true } };
  await declineInvite(weirdId);
  expect(last().url).toContain(`/platform/invites/${encodeURIComponent(weirdId)}/decline`);
});
