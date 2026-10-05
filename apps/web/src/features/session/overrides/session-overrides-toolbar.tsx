'use client';

import { InfoBanner } from '@/components/ui/info-banner';
import { successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import type { SessionScope } from '@kortix/sdk';
import {
  CpuIcon as Cpu,
  KeyIcon as KeyRound,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  SessionSecretsEditor,
} from '@/features/session/scope/session-scope-control';
import {
  createSessionScopeDraft,
  resetSessionSecrets,
  sessionSecretsAreOverridden,
  sessionSecretsSummary,
  type SessionScopeCommit,
  type SessionScopeDraft,
  type SessionScopeSelectionCatalog,
} from '@/features/session/scope/session-scope-model';
import {
  commitSessionScopeDraft,
  createNewSessionScopeInitialization,
  getSessionScopeAvailability,
} from '@/features/session/scope/session-scope-toolbar';
import { useSessionScope } from '@/features/session/scope/use-session-scope';
import { useFeatureFlag, useSessionProviderSecretPools } from '@kortix/sdk/react';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { SessionOverridesControl, type SessionOverrideRow } from './session-overrides-control';
import { useProviderPoolEditingState } from './provider-pool-draft-context';
import { effectiveProviderPools, updateProviderPoolDraft } from './provider-pool-draft';

// The pooled-key editors read the full LLM provider catalog (`lib/llm-providers`
// → the bundled models.dev snapshot). They render only when the user opens the
// "Provider keys" row, so they load then — not with every composer.
const ProviderSecretPoolEditor = dynamic(
  () => import('./provider-secret-pool-editor').then((mod) => mod.ProviderSecretPoolEditor),
  { ssr: false },
);
const NewProviderSecretPoolEditor = dynamic(
  () => import('./provider-secret-pool-editor').then((mod) => mod.NewProviderSecretPoolEditor),
  { ssr: false },
);

const unavailableCatalog: SessionScopeSelectionCatalog = {
  secrets: { status: 'unavailable' },
  connector_connections: { status: 'unavailable' },
};

/** An axis whose control the composer already owns, handed in as a slot. */
export interface SessionOverrideSlot {
  /**
   * What it resolves to now. When nothing overrides the axis this names its
   * real source ("Agent default", "Project default") — never "none".
   */
  summary: string;
  overridden?: boolean;
  control: ReactNode;
  description?: string;
  /** Drops the override — hands the axis back to its default. */
  onReset?: () => void;
  resetLabel?: string;
}

export interface SessionOverridesToolbarProps {
  projectId: string;
  sessionId?: string;
  /**
   * Whose grant the scope is read against — secrets and connectors both
   * default to what this agent's `kortix.yaml` allows. Not a rendered row:
   * the agent is picked on the composer itself.
   */
  agentName?: string;
  onCommittedDraft?: (commit: SessionScopeCommit | undefined) => void;
  providerSecretPools?: Record<string, string[]>;
  onProviderSecretPoolsChange?: (selection: Record<string, string[]>) => void;
  /** Create-time only. Shown so the session's environment is not a mystery. */
  sandbox?: { slug: string | null; provider: string | null };
  /**
   * Pre-create only: the sandbox template IS still choosable, so the row gets
   * a real editor instead of the read-only summary.
   */
  sandboxSlot?: SessionOverrideSlot;
}

function activeScopeSignature(scope: SessionScope | undefined): string {
  if (!scope) return 'pending';
  return JSON.stringify({
    secrets_allowlist: scope.secrets_allowlist,
    connector_bindings: scope.connector_bindings,
    connector_bindings_configured: scope.connector_bindings_configured,
    retroactive: scope.retroactive,
  });
}

function newScopeCatalogSignature(catalog: SessionScopeSelectionCatalog): string {
  return JSON.stringify(catalog);
}

function hasAvailableScopeAxis(catalog: SessionScopeSelectionCatalog): boolean {
  const availability = getSessionScopeAvailability(catalog);
  return availability.secrets || availability.connector_bindings;
}

function providerPoolSummary(
  sessionId: string | undefined,
  isError: boolean,
  isLoading: boolean,
  poolCount: number,
  selectedCount: number,
  t: ReturnType<typeof useTranslations<'pooledSecrets'>>,
): string {
  if (sessionId && isError) return t('keysLoadError');
  if (sessionId && isLoading) return t('loadingKeys');
  return poolCount
    ? t(selectedCount === 1 ? 'selectedOne' : 'selectedKeys', { count: selectedCount })
    : t('projectDefaultShort');
}

function sandboxRow(
  slot: SessionOverrideSlot | undefined,
  sandbox: SessionOverridesToolbarProps['sandbox'],
  t: ReturnType<typeof useTranslations<'hardcodedUi.i18nComplete'>>,
): SessionOverrideRow {
  if (slot) return {
    id: 'sandbox', name: 'Sandbox', icon: Cpu,
    hint: t.raw('text6cc00d310273'), summary: slot.summary,
    overridden: slot.overridden,
    description: slot.description ??
      'The machine image this session will run on. It is fixed once the session starts — by default the agent’s environment, then the project or platform default.',
    editor: slot.control, onReset: slot.onReset, resetLabel: slot.resetLabel,
  };
  return {
    id: 'sandbox', name: 'Sandbox', icon: Cpu,
    hint: t.raw('text57c8f2cd3dd6'),
    summary: sandbox?.slug ?? t.raw('text0b1bdec38bf0'),
    description: t.raw('textf3ad568c3fa6'), readOnly: true,
    editor: (
      <dl className="text-sm">
        <div className="border-border flex items-center justify-between gap-3 border-b py-2">
          <dt className="text-muted-foreground text-xs">
            {t.raw('text0575f29df888')}
          </dt>
          <dd className="text-foreground truncate text-xs">
            {sandbox?.slug ?? t.raw('text0b1bdec38bf0')}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted-foreground text-xs">
            {t.raw('text472590ae974d')}
          </dt>
          <dd className="text-foreground truncate text-xs">
            {sandbox?.provider ?? 'Automatic'}
          </dd>
        </div>
      </dl>
    ),
  };
}

function secretsRow(
  draft: SessionScopeDraft,
  catalog: SessionScopeSelectionCatalog,
  loading: string | null,
  disabled: boolean,
  onChange: (draft: SessionScopeDraft) => void,
  t: ReturnType<typeof useTranslations<'hardcodedUi.i18nComplete'>>,
): SessionOverrideRow {
  return {
    id: 'secrets', name: 'Secrets', icon: KeyRound,
    hint: t.raw('textb9967f948f93'),
    summary: loading ?? (catalog.secrets.status === 'ready' ? sessionSecretsSummary(draft) : 'Unavailable'),
    overridden: sessionSecretsAreOverridden(draft),
    description: t.raw('text71c0873a1cc2'), resetLabel: 'Reset to agent default',
    editor: <SessionSecretsEditor draft={draft} catalog={catalog} loading={loading !== null} disabled={disabled} onChange={onChange} />,
    onReset: () => onChange(resetSessionSecrets(draft)),
  };
}

function providerKeysRow(
  projectId: string,
  sessionId: string | undefined,
  selection: Record<string, string[]>,
  drafts: Record<string, string[] | null>,
  isError: boolean,
  isLoading: boolean,
  gatewayEnabled: boolean,
  saving: boolean,
  onDraftChange: (provider: string, selection: string[] | null) => void,
  onSelectionChange: SessionOverridesToolbarProps['onProviderSecretPoolsChange'],
  t: ReturnType<typeof useTranslations<'pooledSecrets'>>,
): SessionOverrideRow {
  const selectedCount = Object.values(selection).reduce((count, ids) => count + ids.length, 0);
  const poolCount = Object.keys(selection).length;
  return {
    id: 'provider-keys', name: t('providerKeys'), icon: KeyRound,
    hint: t('chooseSharedKeys'),
    summary: providerPoolSummary(sessionId, isError, isLoading, poolCount, selectedCount, t),
    overridden: poolCount > 0, description: t('rateLimitDescription'),
    editor: !gatewayEnabled
      ? <p className="text-muted-foreground text-xs">{t('enableGateway')}</p>
      : sessionId
        ? <ProviderSecretPoolEditor projectId={projectId} sessionId={sessionId} drafts={drafts} onChange={onDraftChange} saving={saving} />
        : <NewProviderSecretPoolEditor projectId={projectId} selection={selection} onChange={onSelectionChange ?? (() => {})} />,
  };
}

/**
 * The per-session overrides that have no control of their own, behind one
 * composer control: secrets, connectors, and the sandbox.
 *
 * It owns the scope draft (secrets + connectors). It deliberately does NOT
 * render agent, model or reasoning effort — each of those is already a live
 * control on the composer itself (agent in `composer-underbar.tsx`, model and
 * effort in `composer-toolbar.tsx`), so a row here would be a second control
 * for the same value one click away. They used to be optional slots; the
 * branches went with the last caller that passed them. Re-adding one means
 * adding a `SessionOverrideSlot` prop and a `rows` entry — see how `sandboxSlot`
 * does it directly below.
 *
 * The sandbox row is read-only on purpose: a session's environment is fixed at
 * create, and a control that looked editable would be a lie.
 */
export function SessionOverridesToolbar({
  projectId,
  sessionId,
  agentName,
  onCommittedDraft,
  providerSecretPools,
  onProviderSecretPoolsChange,
  sandbox,
  sandboxSlot,
}: SessionOverridesToolbarProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tPooled = useTranslations('pooledSecrets');
  const tScope = useTranslations('sessionScope');
  const pooledSecretsEnabled = useFeatureFlag(projectId, 'pooled_provider_secrets').enabled;
  const llmGatewayEnabled = useFeatureFlag(projectId, 'llm_gateway').enabled;
  const providerPools = useSessionProviderSecretPools(
    pooledSecretsEnabled && llmGatewayEnabled ? projectId : null, sessionId,
  );
  // `project.secret.read` is a manager-tier leaf. Without it the catalog reads
  // `unavailable`, and the row only ever said "Secret access is unavailable" —
  // an axis the viewer can neither see nor change. Drop it on a SETTLED denial;
  // a failed catalog read for someone who IS allowed keeps its row.
  const secretRead = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ);
  const secretsDenied = !secretRead.isLoading && !secretRead.allowed;
  const { scope, catalog, catalogError, saveScope, isLoading, isScopeLoading } = useSessionScope({
    projectId,
    sessionId,
    agentName,
  });
  const committedDraftRef = useRef(onCommittedDraft);
  useEffect(() => {
    committedDraftRef.current = onCommittedDraft;
  }, [onCommittedDraft]);

  const initializationKey = useMemo(() => {
    if (!catalog) return null;
    const identity = `${projectId}:${sessionId ?? 'new'}:${agentName ?? ''}`;
    if (sessionId) {
      if (!scope) return null;
      return `${identity}:${catalog.secrets.status}:${catalog.connector_connections.status}:${activeScopeSignature(scope)}`;
    }
    return `${identity}:${newScopeCatalogSignature(catalog)}`;
  }, [agentName, catalog, projectId, scope, sessionId]);

  const [draftState, setDraftState] = useState<{ key: string | null; draft: SessionScopeDraft }>({
    key: null,
    draft: {},
  });
  const [retroactive, setRetroactive] = useState<boolean | undefined>();
  const { providerDrafts, setProviderDrafts, saveError, setSaveError, saving, setSaving, savingRef } = useProviderPoolEditingState();
  const providerPoolDraft = useMemo(() => sessionId
    ? effectiveProviderPools(providerPools.data?.pools ?? [], providerDrafts)
    : providerSecretPools ?? {}, [sessionId, providerPools.data?.pools, providerDrafts, providerSecretPools]);
  const hasProviderChanges = Object.keys(providerDrafts).length > 0;
  const onProviderDraftChange = useCallback((provider: string, selection: string[] | null) => {
    setSaveError(null);
    setProviderDrafts((current) => updateProviderPoolDraft(current, provider, selection, providerPools.data?.pools ?? []));
  }, [providerPools.data?.pools, setProviderDrafts, setSaveError]);

  useEffect(() => {
    if (!catalog || !initializationKey) return;
    if (draftState.key === initializationKey) return;
    const initialization =
      sessionId && scope
        ? { draft: createSessionScopeDraft(scope, catalog), commit: undefined }
        : createNewSessionScopeInitialization(catalog);
    setDraftState({ key: initializationKey, draft: initialization.draft });
    setRetroactive(sessionId ? scope?.retroactive : undefined);
    if (!sessionId) committedDraftRef.current?.(initialization.commit);
  }, [catalog, draftState.key, initializationKey, scope, sessionId]);

  const activeCatalog = catalog ?? unavailableCatalog;
  const initialized = draftState.key === initializationKey && initializationKey !== null;
  // The secrets draft exists once the catalog (and, for a session, its scope)
  // has answered. Until then the Secrets row cannot be edited, so Save commits
  // what is ready: provider keys. A new session applies its keys live, so its
  // Save never waits.
  const scopeReady = initialized && (!sessionId || (Boolean(scope) && !isScopeLoading));
  const saveDisabled = Boolean(sessionId) && (hasProviderChanges
    ? providerPools.isError || providerPools.isLoading || !providerPools.data?.can_edit
    : !(scopeReady && hasAvailableScopeAxis(activeCatalog)));

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      for (const [providerId, secretIds] of Object.entries(providerDrafts)) {
        await providerPools.setPool.mutateAsync({ providerId, secretIds });
        setProviderDrafts((current) => {
          if (current[providerId] !== secretIds) return current;
          const next = { ...current };
          delete next[providerId];
          return next;
        });
      }
      if (catalog && scopeReady) {
        const result = await commitSessionScopeDraft({
          sessionId,
          draft: draftState.draft,
          catalog,
          previousScope: scope,
          replaceScope: saveScope.mutateAsync,
          onCommittedDraft: committedDraftRef.current,
        });
        if (sessionId && result) {
          setRetroactive(result.retroactive);
          setDraftState({ key: initializationKey, draft: createSessionScopeDraft(result, catalog) });
        }
      }
      successToast(tI18nComplete.raw(sessionId ? 'textdf7987d6fd91' : 'text2467c93661b7'));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : tI18nComplete.raw('textb9dc64b38ee1');
      setSaveError(message);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [
    catalog,
    providerDrafts,
    providerPools.setPool,
    setProviderDrafts,
    setSaveError,
    setSaving,
    savingRef,
    draftState.draft,
    initializationKey,
    scopeReady,
    saveScope.mutateAsync,
    scope,
    sessionId,
    tI18nComplete,
  ]);

  const draft = draftState.draft;
  const onChange = useCallback(
    (next: SessionScopeDraft) => setDraftState((current) => ({ ...current, draft: next })),
    [],
  );
  const controlsDisabled = saving || isLoading || (Boolean(sessionId) && !scope);
  // Not answered yet, as opposed to answered "unavailable": a failed catalog
  // read carries an error, and an existing session also waits for its scope.
  const secretsLoading = (!catalog && !catalogError) || (Boolean(sessionId) && isScopeLoading)
    ? tScope('secrets.loading')
    : null;
  const rows = useMemo(() => {
    const list: SessionOverrideRow[] = [];
    if (!secretsDenied) list.push(secretsRow(draft, activeCatalog, secretsLoading,
      controlsDisabled || saveScope.isPending, onChange, tI18nComplete));
    // NO Connectors axis. A session used to pin one connection per connector
    // here, and check a connector that had nothing connected — which recorded a
    // requirement the next turn refused on, with no way to authorize from the
    // card it showed. Credentials are not a session-minting decision: the agent
    // may use every account it is entitled to and names one at call time
    // (`kortix connectors call --account`, `accounts` to see them).
    if (pooledSecretsEnabled) list.push(providerKeysRow(projectId, sessionId,
      providerPoolDraft, providerDrafts, providerPools.isError, providerPools.isLoading,
      llmGatewayEnabled, saving, onProviderDraftChange, onProviderSecretPoolsChange, tPooled));
    list.push(sandboxRow(sandboxSlot, sandbox, tI18nComplete));
    return list;
  }, [
    secretsDenied,
    activeCatalog,
    secretsLoading,
    controlsDisabled,
    draft,
    onChange,
    pooledSecretsEnabled,
    llmGatewayEnabled,
    providerPoolDraft,
    providerDrafts,
    onProviderDraftChange,
    saving,
    providerPools.isError,
    providerPools.isLoading,
    onProviderSecretPoolsChange,
    projectId,
    sessionId,
    sandbox,
    sandboxSlot,
    saveScope.isPending,
    tI18nComplete,
    tPooled,
  ]);

  // Nothing left to change (a member in an existing session: the sandbox row is
  // read-only and fixed at create). A gear that opens onto a Save button and
  // "Changes apply to the next prompt" over nothing editable is a dead end.
  if (rows.every((row) => row.readOnly)) return null;

  return (
    <SessionOverridesControl
      rows={rows}
      // Only a save locks the whole panel. A row that is still loading
      // disables its own editor (see `controlsDisabled` above).
      disabled={saving}
      saving={saving}
      pendingNote={hasProviderChanges ? tPooled('unsavedChanges') : undefined}
      error={saveError}
      saveDisabled={saveDisabled}
      hideSave={!rows.some((row) => row.id === 'secrets' || row.id === 'provider-keys')}
      notice={
        retroactive === false ? (
          <InfoBanner
            tone="warning"
            icon={TriangleAlert}
            title={tI18nComplete.raw('texta6cd531093d4')}
          >
            {tI18nComplete.raw('text54a4e6b3594a')}
          </InfoBanner>
        ) : null
      }
      onSave={handleSave}
    />
  );
}
