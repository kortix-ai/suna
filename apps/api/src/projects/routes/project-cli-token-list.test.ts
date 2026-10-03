/**
 * GET /v1/projects/:projectId/cli-token — a person's CLI token list must not
 * show session-bound credentials as ordinary tokens.
 *
 * The runtime mints one project-scoped token per session (`mintConnectorToken`,
 * `platform/services/session-sandbox.ts`, name `Session <8-hex>`) and injects
 * it into the sandbox as `KORTIX_TOKEN`. `listAccountTokens` returns every
 * project-scoped row, so `kortix projects cli-tokens ls` gained rows a person
 * never minted (dogfood journey `tokens-project-cli-token`, KRTX-1193): a
 * `Session abc12345` row still reading "active" long after its session ended,
 * with no indication of provenance. The tokens page already made this call
 * server-side (`listPersonalAccountTokens`, `session_id IS NULL`): session
 * credentials belong to the session lifecycle, not to a person's key list —
 * revoking the one a live box still holds bricks that session (learnings,
 * 2026-10-01).
 *
 * The route now hides session-bound rows and reports how many it hid
 * (`session_tokens`), so the CLI can explain what is not listed. The test
 * drives the REAL handler through the shared `projectsApp` with the repository
 * and access layer stubbed (`mock.module` is process-global in bun:test, so
 * this runs in its own file).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '00000000-0000-4000-a000-0000000280a0';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000280a1';
const USER_ID = '00000000-0000-4000-a000-0000000280a2';
const SESSION_ID = '00000000-0000-4000-a000-0000000280b0';

/** The rows `listAccountTokens` hands the handler — one hand-minted CLI token,
 *  one live session token, one revoked one (a stopped session never revokes
 *  its token until the session is deleted). */
let tokens: Array<Record<string, unknown>> = [];

function row(
  tokenId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tokenId,
    publicKey: `pk_${tokenId.slice(0, 4)}`,
    name: `token ${tokenId.slice(0, 4)}`,
    status: 'active',
    projectId: PROJECT_ID,
    sessionId: null,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    revokedAt: null,
    ...extra,
  };
}

mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  // Import-time safety only: the handler under test touches neither `db` nor
  // the real repository query (both are stubbed below), so any use here is a
  // bug. A chainable no-op keeps module loading alive without pretending to
  // answer a query.
  db: new Proxy({}, {
    get: () => () => new Proxy({}, { get: () => () => ({ returning: async () => [] }) }),
  }),
}));

// Every export stays real (the auth middleware in the import chain binds
// `validateAccountToken` and friends); only the list is stubbed.
const realRepo = await import('../../repositories/account-tokens');
mock.module('../../repositories/account-tokens', () => ({
  ...realRepo,
  listAccountTokens: async () => tokens,
}));

mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID },
    projectRole: 'owner',
    effectiveRole: 'owner',
  }),
  assertProjectCapability: async () => {},
  assertAgentSessionWorkspaceAllowsRepository: async () => {},
  projectCapabilityAllowed: async () => true,
}));

// Registers project-credentials.ts's routes onto the shared `projectsApp`
// singleton. projects.ts (which attaches the `supabaseAuth` middleware) is
// deliberately NOT imported, so this request needs no Authorization header.
const { projectsApp } = await import('../lib/app');
await import('./project-credentials');

function get() {
  return projectsApp.request(`/${PROJECT_ID}/cli-token`, { method: 'GET' });
}

interface ListedItem {
  token_id: string;
  name: string;
}

beforeEach(() => {
  tokens = [];
});

describe('GET /:projectId/cli-token — session-bound tokens are not CLI tokens', () => {
  test('lists only the hand-minted tokens and reports the session tokens it hid', async () => {
    tokens = [
      row('hand0001', { name: 'cli · Parity' }),
      row('sess0002', { name: 'Session abc12345', sessionId: SESSION_ID }),
      row('sess0003', {
        name: 'Session def67890',
        sessionId: `${SESSION_ID.slice(0, -1)}1`,
        status: 'revoked',
        revokedAt: new Date('2026-01-02T00:00:00Z'),
      }),
    ];
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ListedItem[]; session_tokens: number };
    expect(body.items.map((t) => t.token_id)).toEqual(['hand0001']);
    expect(body.items[0]?.name).toBe('cli · Parity');
    expect(body.session_tokens).toBe(2);
  });

  test('a list of nothing but session tokens is empty — not "no tokens at all"', async () => {
    tokens = [row('sess0004', { name: 'Session abc12345', sessionId: SESSION_ID })];
    const res = await get();
    const body = (await res.json()) as { items: ListedItem[]; session_tokens: number };
    expect(body.items).toEqual([]);
    expect(body.session_tokens).toBe(1);
  });

  test('no session tokens on the project: the count is 0 and the list is unchanged', async () => {
    tokens = [row('hand0005', { name: 'cli · Parity' })];
    const res = await get();
    const body = (await res.json()) as { items: ListedItem[]; session_tokens: number };
    expect(body.items.map((t) => t.token_id)).toEqual(['hand0005']);
    expect(body.session_tokens).toBe(0);
  });
});
