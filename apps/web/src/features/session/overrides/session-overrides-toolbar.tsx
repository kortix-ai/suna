'use client';

import { InfoBanner } from '@/components/ui/info-banner';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import type { SessionScope } from '@kortix/sdk';
import {
  CpuIcon as Cpu,
  KeyIcon as KeyRound,
  PlugIcon as PlugZap,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  SessionConnectorsEditor,
  SessionSecretsEditor,
} from '@/features/session/scope/session-scope-control';
import {
  createSessionScopeDraft,
  resetSessionConnectorBindings,
  resetSessionSecrets,
  sessionConnectorsAreOverridden,
  sessionConnectorsSummary,
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

import { SessionOverridesControl, type SessionOverrideRow } from './session-overrides-control';

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
  sandbox,
  sandboxSlot,
}: SessionOverridesToolbarProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { scope, catalog, saveScope, isLoading, isScopeLoading } = useSessionScope({
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
  const saveDisabled =
    !initialized ||
    !hasAvailableScopeAxis(activeCatalog) ||
    (Boolean(sessionId) && (!scope || isScopeLoading));

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!catalog || !initialized) return false;
    try {
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
        successToast(tI18nComplete.raw('textdf7987d6fd91'));
      } else if (!sessionId) {
        successToast(tI18nComplete.raw('text2467c93661b7'));
      }
      return true;
    } catch (error) {
      errorToast(error instanceof Error ? error.message : tI18nComplete.raw('textb9dc64b38ee1'));
      return false;
    }
  }, [
    catalog,
    draftState.draft,
    initializationKey,
    initialized,
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
  const controlsDisabled = isLoading || (Boolean(sessionId) && !scope);

  const rows = useMemo(() => {
    const list: SessionOverrideRow[] = [];
    list.push({
      id: 'secrets',
      name: 'Secrets',
      icon: KeyRound,
      hint: tI18nComplete.raw('textb9967f948f93'),
      summary:
        activeCatalog.secrets.status === 'ready' ? sessionSecretsSummary(draft) : 'Unavailable',
      overridden: sessionSecretsAreOverridden(draft),
      description: tI18nComplete.raw('text71c0873a1cc2'),
      resetLabel: 'Reset to agent default',
      editor: (
        <SessionSecretsEditor
          draft={draft}
          catalog={activeCatalog}
          disabled={controlsDisabled || saveScope.isPending}
          onChange={onChange}
        />
      ),
      onReset: () => onChange(resetSessionSecrets(draft)),
    });
    list.push({
      id: 'connectors',
      name: 'Connectors',
      icon: PlugZap,
      hint: tI18nComplete.raw('textaea537d63c8c'),
      summary:
        activeCatalog.connector_connections.status === 'ready'
          ? sessionConnectorsSummary(draft)
          : 'Unavailable',
      overridden: sessionConnectorsAreOverridden(draft),
      description: tI18nComplete.raw('text11022f38d525'),
      resetLabel: 'Reset to agent default',
      editor: (
        <SessionConnectorsEditor
          draft={draft}
          catalog={activeCatalog}
          disabled={controlsDisabled || saveScope.isPending}
          onChange={onChange}
        />
      ),
      onReset: () => onChange(resetSessionConnectorBindings(draft, activeCatalog)),
    });
    if (sandboxSlot) {
      // Pre-create: the template is still a real choice.
      list.push({
        id: 'sandbox',
        name: 'Sandbox',
        icon: Cpu,
        hint: tI18nComplete.raw('text6cc00d310273'),
        summary: sandboxSlot.summary,
        overridden: sandboxSlot.overridden,
        description:
          sandboxSlot.description ??
          'The machine image this session will run on. It is fixed once the session starts — by default the agent’s environment, then the project or platform default.',
        editor: sandboxSlot.control,
        onReset: sandboxSlot.onReset,
        resetLabel: sandboxSlot.resetLabel,
      });
    } else {
      list.push({
        id: 'sandbox',
        name: 'Sandbox',
        icon: Cpu,
        hint: tI18nComplete.raw('text57c8f2cd3dd6'),
        summary: sandbox?.slug ?? tI18nComplete.raw('text0b1bdec38bf0'),
        description: tI18nComplete.raw('textf3ad568c3fa6'),
        readOnly: true,
        editor: (
          <dl className="text-sm">
            <div className="border-border flex items-center justify-between gap-3 border-b py-2">
              <dt className="text-muted-foreground text-xs">
                {tI18nComplete.raw('text0575f29df888')}
              </dt>
              <dd className="text-foreground truncate text-xs">
                {sandbox?.slug ?? tI18nComplete.raw('text0b1bdec38bf0')}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-muted-foreground text-xs">
                {tI18nComplete.raw('text472590ae974d')}
              </dt>
              <dd className="text-foreground truncate text-xs">
                {sandbox?.provider ?? 'Automatic'}
              </dd>
            </div>
          </dl>
        ),
      });
    }
    return list;
  }, [
    activeCatalog,
    controlsDisabled,
    draft,
    onChange,
    sandbox,
    sandboxSlot,
    saveScope.isPending,
    tI18nComplete,
  ]);

  return (
    <SessionOverridesControl
      rows={rows}
      disabled={controlsDisabled}
      saving={saveScope.isPending}
      saveDisabled={saveDisabled}
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
