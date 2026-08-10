'use client';

import { InfoBanner } from '@/components/ui/info-banner';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  CpuIcon as Cpu,
  BrainIcon as Brain,
  KeyIcon as KeyRound,
  PlugIcon as PlugZap,
  RobotIcon as Robot,
  SparkleIcon as Sparkle,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import type { SessionScope } from '@kortix/sdk';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  /** What it resolves to now. "Project default" when nothing is overriding it. */
  summary: string;
  overridden?: boolean;
  control: ReactNode;
  description?: string;
}

export interface SessionOverridesToolbarProps {
  projectId: string;
  sessionId?: string;
  agentName?: string;
  onCommittedDraft?: (commit: SessionScopeCommit | undefined) => void;
  agent?: SessionOverrideSlot;
  model?: SessionOverrideSlot;
  reasoningEffort?: SessionOverrideSlot;
  /** Create-time only. Shown so the session's environment is not a mystery. */
  sandbox?: { slug: string | null; provider: string | null };
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
 * Every per-session override, behind one composer control.
 *
 * It owns the scope draft (secrets + connectors) and borrows the agent, model
 * and reasoning-effort controls the composer already renders, so each axis
 * keeps exactly one implementation. The sandbox row is read-only on purpose:
 * a session's environment is fixed at create, and a control that looked
 * editable would be a lie.
 */
export function SessionOverridesToolbar({
  projectId,
  sessionId,
  agentName,
  onCommittedDraft,
  agent,
  model,
  reasoningEffort,
  sandbox,
}: SessionOverridesToolbarProps) {
  const { scope, catalog, saveScope, isLoading, isScopeLoading } = useSessionScope({
    projectId,
    sessionId,
    agentName,
  });
  const committedDraftRef = useRef(onCommittedDraft);
  committedDraftRef.current = onCommittedDraft;

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

  const handleSave = useCallback(async () => {
    if (!catalog || !initialized) return;
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
        successToast('Session overrides saved');
      } else if (!sessionId) {
        successToast('Session overrides configured');
      }
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Session overrides could not be saved');
    }
  }, [
    catalog,
    draftState.draft,
    initializationKey,
    initialized,
    saveScope.mutateAsync,
    scope,
    sessionId,
  ]);

  const draft = draftState.draft;
  const onChange = useCallback(
    (next: SessionScopeDraft) => setDraftState((current) => ({ ...current, draft: next })),
    [],
  );
  const controlsDisabled = isLoading || (Boolean(sessionId) && !scope);

  const rows = useMemo(() => {
    const list: SessionOverrideRow[] = [];
    if (agent) {
      list.push({
        id: 'agent',
        name: 'Agent',
        icon: Robot,
        hint: 'Who answers',
        summary: agent.summary,
        overridden: agent.overridden,
        description:
          agent.description ??
          'The agent that answers your next prompt. It also decides the ceiling for every other axis here — a session can never reach past what its agent is granted.',
        editor: agent.control,
      });
    }
    if (model) {
      list.push({
        id: 'model',
        name: 'Model',
        icon: Sparkle,
        hint: 'Which model',
        summary: model.summary,
        overridden: model.overridden,
        description:
          model.description ??
          'The model this session sends to. Leave it on the project default unless this one session needs something else.',
        editor: model.control,
      });
    }
    if (reasoningEffort) {
      list.push({
        id: 'reasoning-effort',
        name: 'Reasoning effort',
        icon: Brain,
        hint: 'How hard it thinks',
        summary: reasoningEffort.summary,
        overridden: reasoningEffort.overridden,
        description:
          reasoningEffort.description ??
          'How much the model reasons before it answers. This one is stored per project and per model, so every session in this project using this model follows it.',
        editor: reasoningEffort.control,
      });
    }
    list.push({
      id: 'secrets',
      name: 'Secrets',
      icon: KeyRound,
      hint: 'Environment values',
      summary:
        activeCatalog.secrets.status === 'ready' ? sessionSecretsSummary(draft) : 'Unavailable',
      overridden: sessionSecretsAreOverridden(draft),
      description:
        'Which project secrets reach this session. The default is everything this agent is granted; narrowing it here only ever takes access away.',
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
      hint: 'Authorized accounts',
      summary:
        activeCatalog.connector_connections.status === 'ready'
          ? sessionConnectorsSummary(draft)
          : 'Unavailable',
      overridden: sessionConnectorsAreOverridden(draft),
      description:
        'Which connected accounts this session may use. On the project default each one resolves to the project’s active connection; pick here only to pin this session to something else.',
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
    list.push({
      id: 'sandbox',
      name: 'Sandbox',
      icon: Cpu,
      hint: 'Where it runs',
      summary: sandbox?.slug ?? 'Project default',
      description:
        'The machine image this session runs on. It is chosen when the session is created and cannot be changed afterwards — start a new session to use a different one.',
      readOnly: true,
      editor: (
        <dl className="text-sm">
          <div className="border-border flex items-center justify-between gap-3 border-b py-2">
            <dt className="text-muted-foreground text-xs">Template</dt>
            <dd className="text-foreground truncate text-xs">{sandbox?.slug ?? 'Project default'}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-muted-foreground text-xs">Provider</dt>
            <dd className="text-foreground truncate text-xs">{sandbox?.provider ?? 'Automatic'}</dd>
          </div>
        </dl>
      ),
    });
    return list;
  }, [
    activeCatalog,
    agent,
    controlsDisabled,
    draft,
    model,
    onChange,
    reasoningEffort,
    sandbox,
    saveScope.isPending,
  ]);

  return (
    <SessionOverridesControl
      rows={rows}
      disabled={controlsDisabled}
      saving={saveScope.isPending}
      saveDisabled={saveDisabled}
      notice={
        retroactive === false ? (
          <InfoBanner tone="warning" icon={TriangleAlert} title="Existing context is unchanged">
            Removed secret values can remain in the current conversation or existing shells.
          </InfoBanner>
        ) : null
      }
      onSave={handleSave}
    />
  );
}
