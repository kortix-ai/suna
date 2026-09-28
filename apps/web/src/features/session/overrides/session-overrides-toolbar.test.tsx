import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionOverrideRow } from './session-overrides-control';

let rows: SessionOverrideRow[] = [];
let sessionId: string | undefined;
let poolEnabled = false;
let poolLoading = false;
let poolError = false;
let secretAllowed = true;
let selection: Record<string, string[]> = {};

mock.module('./session-overrides-control', () => ({
  SessionOverridesControl: ({ rows: next }: { rows: SessionOverrideRow[] }) => {
    rows = next;
    return null;
  },
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string, values?: { count: number }) =>
    values ? `${key}:${values.count}` : key, { raw: (key: string) => key }),
}));
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: secretAllowed, isLoading: false }),
}));
mock.module('@/features/session/scope/use-session-scope', () => ({
  useSessionScope: () => ({
    scope: sessionId ? { secrets_allowlist: [], connector_bindings: [] } : undefined,
    catalog: { secrets: { status: 'ready', options: [] }, connector_connections: { status: 'unavailable' } },
    saveScope: { isPending: false, mutateAsync: async () => {} },
    isLoading: false,
    isScopeLoading: false,
  }),
}));
mock.module('@kortix/sdk/react', () => ({
  useFeatureFlag: (_project: string, flag: string) => ({ enabled: flag === 'llm_gateway' || poolEnabled }),
  useSessionProviderSecretPools: () => ({
    data: { pools: [], can_edit: true },
    isError: poolError,
    isLoading: poolLoading,
    setPool: { mutateAsync: async () => {} },
  }),
}));
mock.module('./provider-pool-draft-context', () => ({
  useProviderPoolEditingState: () => ({
    providerDrafts: {}, setProviderDrafts: () => {}, saveError: null, setSaveError: () => {},
    saving: false, setSaving: () => {}, savingRef: { current: false },
  }),
}));
mock.module('./provider-pool-draft', () => ({
  effectiveProviderPools: () => selection,
  updateProviderPoolDraft: () => ({}),
}));

const { SessionOverridesToolbar } = await import('./session-overrides-toolbar');

function render(existing = false) {
  sessionId = existing ? 'synthetic-session' : undefined;
  rows = [];
  renderToStaticMarkup(<SessionOverridesToolbar projectId="synthetic-project" sessionId={sessionId}
    providerSecretPools={selection} sandbox={{ slug: 'standard', provider: 'Automatic' }} />);
  return rows.map(({ id, summary, overridden }) => ({ id, summary, overridden: Boolean(overridden) }));
}

test('new session retains ordered row summaries and override flags', () => {
  poolEnabled = true;
  secretAllowed = true;
  selection = { alpha: ['key-a'], beta: ['key-b'] };
  expect(render()).toEqual([
    { id: 'secrets', summary: 'Unchanged', overridden: false },
    { id: 'provider-keys', summary: 'selectedKeys:2', overridden: true },
    { id: 'sandbox', summary: 'standard', overridden: false },
  ]);
  selection = {};
  expect(render()[1]).toEqual({ id: 'provider-keys', summary: 'projectDefaultShort', overridden: false });
});

test('existing session retains provider loading and failure summaries', () => {
  poolEnabled = true;
  secretAllowed = true;
  selection = { alpha: ['key-a'] };
  expect(render(true).map((row) => row.id)).toEqual(['secrets', 'provider-keys', 'sandbox']);
  expect(render(true)[1]).toEqual({ id: 'provider-keys', summary: 'selectedOne:1', overridden: true });
  poolLoading = true;
  expect(render(true)[1]?.summary).toBe('loadingKeys');
  poolError = true;
  expect(render(true)[1]?.summary).toBe('keysLoadError');
  poolLoading = false;
  poolError = false;
  secretAllowed = false;
  expect(render(true).map((row) => row.id)).toEqual(['provider-keys', 'sandbox']);
});
