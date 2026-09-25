/**
 * Preview traffic attributes its own audit rows.
 *
 * Preview subdomains and the PTY / preview WebSockets are dispatched before
 * Hono, so no auth middleware ever named their caller. The token is proven
 * once (preview-auth.ts); every later request rides a signed cookie. Both
 * paths bind here, and the sandbox's owner — not the caller's account — owns
 * the row, so an attempt on someone's preview lands in THEIR log.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { runWithContext } from '../lib/request-context';
import { attachInboundAuditScope } from '../shared/audit-scope';

const realOwnership = await import('../shared/preview-ownership');
let ownerLookups = 0;
mock.module('../shared/preview-ownership', () => ({
  ...realOwnership,
  resolveSandboxOwner: async (id: string) => {
    ownerLookups += 1;
    return id === 'sbx-known'
      ? { sandboxId: 'sbx-known', accountId: 'acct-owner', projectId: 'proj-1' }
      : null;
  },
}));

const { bindPreviewResource, bindPreviewSession, previewActorFields } = await import(
  './preview-audit'
);

const USER = '00000000-0000-4000-a000-000000000001';

function scopeAfter(fn: () => void) {
  return runWithContext('GET', '/', () => {
    const scope = attachInboundAuditScope({ owner: 'edge', method: 'GET' });
    fn();
    return scope;
  });
}

afterEach(() => {
  ownerLookups = 0;
});

describe('previewActorFields', () => {
  test('a person is the human user', () => {
    expect(
      previewActorFields({ kind: 'user', principalId: USER, sandboxAuthored: false, method: 'jwt' }),
    ).toEqual({
      actorType: 'human',
      actorUserId: USER,
      authoritativeSource: 'human',
      authMethod: { kind: 'jwt' },
    });
  });

  test('the sandbox calling its own preview is the agent, never a person', () => {
    expect(
      previewActorFields({
        kind: 'user',
        principalId: USER,
        sandboxAuthored: true,
        method: 'account_token',
      }),
    ).toEqual({
      actorType: 'agent',
      actorUserId: null,
      authoritativeSource: 'agent',
      authMethod: { kind: 'account_token', principal_id: USER },
    });
    // The session the token is bound to is named with it.
    expect(
      previewActorFields({
        kind: 'user',
        principalId: USER,
        sandboxAuthored: true,
        method: 'account_token',
        callerSessionId: 'ses-1',
      }).authMethod,
    ).toEqual({ kind: 'account_token', principal_id: USER, session_id: 'ses-1' });
  });

  test('a service account is not a user id', () => {
    expect(
      previewActorFields({
        kind: 'service_account',
        principalId: 'sa-1',
        sandboxAuthored: false,
        method: 'service_account',
      }),
    ).toEqual({
      actorType: 'service_account',
      actorUserId: null,
      authoritativeSource: 'automation',
      authMethod: { kind: 'service_account', service_account_id: 'sa-1' },
    });
  });

  test('an account API key is system; its id is an account, never written as a user', () => {
    expect(
      previewActorFields({
        kind: 'account',
        principalId: 'acct-1',
        sandboxAuthored: false,
        method: 'api_key',
      }),
    ).toEqual({
      actorType: 'system',
      actorUserId: null,
      authoritativeSource: 'api_key',
      authMethod: { kind: 'api_key' },
    });
  });

});

// A principal cookie and a cookie minted before the kind existed are
// attributed through the real handler in preview-origin.test.ts.
describe('binding a preview request', () => {
  test('a public share viewer is anonymous, and the share is named', () => {
    const scope = scopeAfter(() =>
      bindPreviewSession({
        kind: 'public_share',
        shareId: 'share-1',
        mode: 'view',
        sandboxLabel: 'sbx-known',
        sandboxId: 'sbx-known',
        port: 3000,
        exp: 0,
      }),
    );
    expect(scope.principal).toEqual({
      actorType: 'anonymous',
      actorUserId: null,
      authoritativeSource: 'public_share',
      authMethod: { kind: 'public_share', share_id: 'share-1' },
    });
  });

  test('the sandbox is the resource, and its owner owns the row', async () => {
    const scope = scopeAfter(() => bindPreviewResource('sbx-known', 3000));
    expect(scope.annotation).toMatchObject({
      resourceType: 'sandbox_preview_origin',
      resourceId: 'sbx-known',
      metadata: { port: 3000 },
    });
    // Resolved when the row is written, not on the request path.
    expect(ownerLookups).toBe(0);
    const late = await scope.principal.lateAttribution?.();
    expect(late).toEqual({ accountId: 'acct-owner', projectId: 'proj-1' });
    expect(ownerLookups).toBe(1);

    // A sandbox nobody knows has no owner to file the row under.
    const unknown = scopeAfter(() => bindPreviewResource('sbx-unknown', null));
    expect(await unknown.principal.lateAttribution?.()).toBeNull();
  });
});
