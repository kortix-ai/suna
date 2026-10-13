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
mock.module('@/features/workspace/customize/sections/connector-oauth2-start', () => ({
  // No one-click OAuth: the hook falls through to credential entry.
  startDiscoveredSignIn: async (_projectId: string, connectionId: string) => {
    calls.push(`sign-in:${connectionId}`);
    return null;
  },
}));
mock.module('@/components/ui/toast', () => ({
  successToast: () => undefined,
  warningToast: () => undefined,
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
async function addAccount(draft: Partial<NewAccountDraft>) {
  let submit: ((draft: NewAccountDraft) => void) | null = null;
  let opened: { connectionId: string; owner: 'project' | 'me' } | null = null;
  let settle = () => undefined as void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  function Probe() {
    submit = useAddAccount({
      projectId: 'synthetic-project',
      connector,
      displayName: 'Vendor',
      onAdded: () => undefined,
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

  test('Only you adds a private account and leaves the shared one alone', async () => {
    expect(await addAccount({ audience: 'private' })).toEqual({
      connectionId: 'mine-1',
      owner: 'me',
    });
    expect(calls).toEqual(['reconcile-member:Vendor 2', 'sign-in:mine-1']);
  });
});
