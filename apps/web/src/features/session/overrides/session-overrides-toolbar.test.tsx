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
// The scope catalog (and, for a session, its scope) has answered.
let catalogLoaded = true;
let providerDrafts: Record<string, string[] | null> = {};
let control: { saveDisabled?: boolean; disabled?: boolean; onSave: () => Promise<boolean> } | null = null;
const poolWrites: Array<{ providerId: string; secretIds: string[] | null }> = [];
const scopeWrites: unknown[] = [];
const toasts: string[] = [];

mock.module('./session-overrides-control', () => ({
  SessionOverridesControl: (props: { rows: SessionOverrideRow[]; saveDisabled?: boolean; disabled?: boolean; onSave: () => Promise<boolean> }) => {
    rows = props.rows;
    control = props;
    return null;
  },
}));
mock.module('@/components/ui/toast', () => ({
  successToast: (message: string) => { toasts.push(message); },
  errorToast: () => {},
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
    scope: sessionId && catalogLoaded ? { secrets_allowlist: [], connector_bindings: [] } : undefined,
    catalog: catalogLoaded
      ? { secrets: { status: 'ready', options: [] }, connector_connections: { status: 'unavailable' } }
      : undefined,
    saveScope: { isPending: false, mutateAsync: async (replacement: unknown) => { scopeWrites.push(replacement); } },
    isLoading: !catalogLoaded,
    isScopeLoading: Boolean(sessionId) && !catalogLoaded,
  }),
}));
mock.module('@kortix/sdk/react', () => ({
  useFeatureFlag: (_project: string, flag: string) => ({ enabled: flag === 'llm_gateway' || poolEnabled }),
  useSessionProviderSecretPools: () => ({
    data: { pools: [], can_edit: true },
    isError: poolError,
    isLoading: poolLoading,
    setPool: { mutateAsync: async (write: { providerId: string; secretIds: string[] | null }) => { poolWrites.push(write); } },
  }),
}));
mock.module('./provider-pool-draft-context', () => ({
  useProviderPoolEditingState: () => ({
    providerDrafts, setProviderDrafts: () => {}, saveError: null, setSaveError: () => {},
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

// The scope catalog (secrets, connectors, connections) can take seconds. It
// used to lock the gear, and Save waited on it too, so provider keys could not
// be changed before a first prompt, or saved in a session, until it answered.
test('a new session saves at once while its secrets catalog loads', async () => {
  poolEnabled = true;
  secretAllowed = true;
  catalogLoaded = false;
  selection = { alpha: ['key-a'] };
  providerDrafts = {};
  toasts.length = 0;
  expect(render()[0]).toEqual({ id: 'secrets', summary: 'secrets.loading', overridden: false });
  // Neither the panel nor its Save button waits on the catalog.
  expect(control?.disabled).toBe(false);
  expect(control?.saveDisabled).toBe(false);
  expect(await control!.onSave()).toBe(true);
  expect(toasts).toEqual(['text2467c93661b7']);
  catalogLoaded = true;
});

test('an existing session saves its provider keys without waiting for the scope', async () => {
  poolEnabled = true;
  secretAllowed = true;
  catalogLoaded = false;
  providerDrafts = { anthropic: ['key-a'] };
  poolWrites.length = 0;
  scopeWrites.length = 0;
  toasts.length = 0;
  render(true);
  expect(control?.saveDisabled).toBe(false);
  expect(await control!.onSave()).toBe(true);
  expect(poolWrites).toEqual([{ providerId: 'anthropic', secretIds: ['key-a'] }]);
  expect(scopeWrites).toEqual([]);
  expect(toasts).toEqual(['textdf7987d6fd91']);
  // Without a key change there is nothing Save can commit until the scope loads.
  providerDrafts = {};
  render(true);
  expect(control?.saveDisabled).toBe(true);
  catalogLoaded = true;
});
