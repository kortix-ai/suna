import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { NewAccountDraft } from '@/features/workspace/customize/sections/view/connector-connections';
import type { AdminConnector, Connection } from '@kortix/sdk';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// The empty shared account the server makes with a connector (`ensureDefaultConnection`).
const SLOT: Connection = {
  connection_id: 'slot-1',
  connector_alias: 'vendor-mcp',
  owner_type: 'project',
  owner_id: null,
  label: 'Vendor',
  status: 'active',
  is_default: false,
  metadata: { default_slot: 'project', connector_slug: 'vendor-mcp' },
  authorized: false,
};
let rows: Connection[] = [];
const calls: string[] = [];
/** Set: the sign-in start fails with this message. */
let signInError: string | null = null;

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  listConnections: async () => ({ connections: rows }),
  reconcileConnection: async (_projectId: string, input: { owner_type: string; label: string }) => {
    calls.push(`reconcile:${input.owner_type}:${input.label}`);
    return { ...SLOT, connection_id: 'new-1', label: input.label, metadata: {} };
  },
  reconcileMemberConnection: async (_projectId: string, input: { label: string }) => {
    calls.push(`reconcile-member:${input.label}`);
    return { ...SLOT, connection_id: 'mine-1', owner_type: 'member', label: input.label };
  },
  renameConnection: async (_projectId: string, connectionId: string, label: string) => {
    calls.push(`rename:${connectionId}:${label}`);
    return { ...SLOT, connection_id: connectionId, label };
  },
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useProjectAccountId: () => 'synthetic-account',
}));
mock.module('@/hooks/connectors/use-add-managed-account', () => ({
  useAddManagedAccount: () => ({ add: async () => undefined, isPending: false }),
}));
mock.module('@/features/workspace/shared/access/access-dialog-share', () => ({
  grantConnectionAccess: async (_accountId: string, _projectId: string, connectionId: string) => {
    calls.push(`grant:${connectionId}`);
  },
}));
const oauth2Start = await import('@/features/workspace/customize/sections/connector-oauth2-start');
mock.module('@/features/workspace/customize/sections/connector-oauth2-start', () => ({
  ...oauth2Start,
  // No one-click OAuth: the hook falls through to credential entry.
  startDiscoveredSignIn: async (_projectId: string, connectionId: string) => {
    calls.push(`sign-in:${connectionId}`);
    if (signInError) throw new Error(signInError);
    return null;
  },
}));
mock.module('@/components/ui/toast', () => ({
  successToast: () => undefined,
  warningToast: (message: string) => calls.push(`warning:${message}`),
  errorToast: (message: string) => calls.push(`error:${message}`),
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
Object.defineProperty(globalThis, 'window', {
  value: { location: { href: 'http://localhost/connector', assign: () => undefined } },
  configurable: true,
});

const { useAddAccount } = await import('./use-add-account');

const connector = {
  slug: 'vendor-mcp',
  name: 'Vendor',
  provider: 'mcp',
  authSecret: 'credential',
} as AdminConnector;

/** Submit one Add account draft; return the account credential entry opened for. */
async function addAccount(draft: Partial<NewAccountDraft>, target: AdminConnector = connector) {
  let submit = null as ((draft: NewAccountDraft) => void) | null;
  let opened = null as { connectionId: string; owner: 'project' | 'me' } | null;
  let settle = () => undefined as void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  function Probe() {
    submit = useAddAccount({
      projectId: 'synthetic-project',
      connector: target,
      displayName: 'Vendor',
      // A connector that needs no credential opens no entry: it is done here.
      onAdded: () => settle(),
      onCredential: (target) => {
        opened = target;
        settle();
      },
    }).submit;
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await act(async () => {
    submit!({
      label: 'Vendor 2',
      audience: 'project',
      picked: { memberIds: [], groupIds: [] },
      ...draft,
    });
    await done;
  });
  return opened;
}

beforeEach(() => {
  rows = [SLOT];
  calls.length = 0;
  signInError = null;
});

describe('a new shared account reuses the empty one made with the connector', () => {
  test('Everyone signs in the empty shared account, never a second one', async () => {
    expect(await addAccount({})).toEqual({ connectionId: 'slot-1', owner: 'project' });
    expect(calls).toEqual(['sign-in:slot-1']);
  });

  test('a name the user typed renames it', async () => {
    expect(await addAccount({ label: 'Team' })).toEqual({
      connectionId: 'slot-1',
      owner: 'project',
    });
    expect(calls).toEqual(['rename:slot-1:Team', 'sign-in:slot-1']);
  });

  test('picked people narrow it before the sign-in', async () => {
    await addAccount({ audience: 'members', picked: { memberIds: ['member-1'], groupIds: [] } });
    expect(calls).toEqual(['grant:slot-1', 'sign-in:slot-1']);
  });

  test('a signed-in shared account is kept: the new account is a second one', async () => {
    rows = [{ ...SLOT, authorized: true }];
    expect(await addAccount({})).toEqual({ connectionId: 'new-1', owner: 'project' });
    expect(calls).toEqual(['reconcile:project:Vendor 2', 'sign-in:new-1']);
  });

  test('a shared account someone added by hand is not the empty one', async () => {
    rows = [{ ...SLOT, metadata: {} }];
    expect(await addAccount({})).toEqual({ connectionId: 'new-1', owner: 'project' });
    expect(calls[0]).toBe('reconcile:project:Vendor 2');
  });

  // `auth: none`: the account made with the connector already works, so it is
  // not an empty one. Everyone adds a second shared account (journey 23).
  test('a connector that needs no credential gets a second shared account', async () => {
    await addAccount({}, { ...connector, provider: 'http', requestAuthType: 'none' } as AdminConnector);
    expect(calls[0]).toBe('reconcile:project:Vendor 2');
  });

  test('Only you adds a private account and leaves the shared one alone', async () => {
    expect(await addAccount({ audience: 'private' })).toEqual({
      connectionId: 'mine-1',
      owner: 'me',
    });
    expect(calls).toEqual(['reconcile-member:Vendor 2', 'sign-in:mine-1']);
  });
});

// KRTX-2185: a sign-in start that failed was swallowed (`catch {}`), and
// credential entry opened with no reason, so an OAuth server looked like it
// wanted a pasted token.
describe('a sign-in that cannot start', () => {
  test('says why, then opens credential entry', async () => {
    signInError = 'OAuth2 client registration failed (400): invalid_redirect_uri';
    expect(await addAccount({ audience: 'private' })).toEqual({ connectionId: 'mine-1', owner: 'me' });
    expect(calls).toEqual(['reconcile-member:Vendor 2', 'sign-in:mine-1', 'warning:addMcpSignInFailed']);
  });
});
