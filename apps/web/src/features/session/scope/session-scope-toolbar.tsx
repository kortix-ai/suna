'use client';

import { errorToast, successToast } from '@/components/ui/toast';
import type { SessionScope, SessionScopeInput } from '@kortix/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SessionScopeControl } from './session-scope-control';
import {
  buildSessionScopeReplacement,
  createNewSessionScopeDraft,
  createSessionScopeDraft,
  type SessionScopeAvailability,
  type SessionScopeCommit,
  type SessionScopeDraft,
  type SessionScopeSelectionCatalog,
} from './session-scope-model';
import { useSessionScope } from './use-session-scope';

const unavailableCatalog: SessionScopeSelectionCatalog = {
  secrets: { status: 'unavailable' },
  connector_profiles: { status: 'unavailable' },
};

export interface SessionScopeToolbarProps {
  projectId: string;
  sessionId?: string;
  agentName?: string;
  onCommittedDraft?: (commit: SessionScopeCommit | undefined) => void;
}

interface CommitSessionScopeDraftInput {
  sessionId?: string;
  draft: SessionScopeDraft;
  catalog: SessionScopeSelectionCatalog;
  previousScope?: SessionScope;
  replaceScope: (replacement: SessionScopeInput) => Promise<SessionScope>;
  onCommittedDraft?: (commit: SessionScopeCommit | undefined) => void;
}

export function getSessionScopeAvailability(
  catalog: SessionScopeSelectionCatalog,
): SessionScopeAvailability {
  return {
    secrets: catalog.secrets.status === 'ready',
    connector_bindings: catalog.connector_profiles.status === 'ready',
  };
}

function hasAvailableScopeAxis(availability: SessionScopeAvailability): boolean {
  return availability.secrets || availability.connector_bindings;
}

function canonicalDraftFromReplacement(replacement: SessionScopeInput): SessionScopeDraft {
  const draft: SessionScopeDraft = {};
  if (Object.hasOwn(replacement, 'secrets')) {
    draft.secrets =
      replacement.secrets === null ? null : replacement.secrets ? [...replacement.secrets] : [];
  }
  if (replacement.connector_bindings) {
    draft.connector_bindings = Object.fromEntries(
      Object.entries(replacement.connector_bindings).map(([alias, binding]) => {
        if (!binding.authorization_id) {
          throw new Error(`Connector ${alias} is missing authorization_id.`);
        }
        return [alias, { authorization_id: binding.authorization_id }];
      }),
    );
  }
  return draft;
}

export function createNewSessionScopeInitialization(catalog: SessionScopeSelectionCatalog): {
  draft: SessionScopeDraft;
  commit: SessionScopeCommit | undefined;
} {
  const availability = getSessionScopeAvailability(catalog);
  const draft = createNewSessionScopeDraft(catalog);
  if (!hasAvailableScopeAxis(availability)) {
    return { draft, commit: undefined };
  }
  const replacement = buildSessionScopeReplacement(draft, undefined, availability);
  return {
    draft,
    commit: {
      draft: canonicalDraftFromReplacement(replacement),
      availability,
    },
  };
}

export async function commitSessionScopeDraft({
  sessionId,
  draft,
  catalog,
  previousScope,
  replaceScope,
  onCommittedDraft,
}: CommitSessionScopeDraftInput): Promise<SessionScope | undefined> {
  const availability = getSessionScopeAvailability(catalog);
  if (!hasAvailableScopeAxis(availability)) return undefined;

  const replacement = buildSessionScopeReplacement(draft, previousScope, availability);
  if (!sessionId) {
    onCommittedDraft?.({
      draft: canonicalDraftFromReplacement(replacement),
      availability,
    });
    return undefined;
  }
  if (!previousScope) {
    throw new Error('The current session scope is required before replacement.');
  }
  return replaceScope(replacement);
}

function activeScopeSignature(scope: SessionScope | undefined): string {
  if (!scope) return 'pending';
  return JSON.stringify({
    secrets_allowlist: scope.secrets_allowlist,
    connector_bindings: scope.connector_bindings,
    retroactive: scope.retroactive,
  });
}

function newScopeCatalogSignature(catalog: SessionScopeSelectionCatalog): string {
  return JSON.stringify(catalog);
}

export function SessionScopeToolbar({
  projectId,
  sessionId,
  agentName,
  onCommittedDraft,
}: SessionScopeToolbarProps) {
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
      return `${identity}:${catalog.secrets.status}:${catalog.connector_profiles.status}:${activeScopeSignature(scope)}`;
    }
    return `${identity}:${newScopeCatalogSignature(catalog)}`;
  }, [agentName, catalog, projectId, scope, sessionId]);

  const [draftState, setDraftState] = useState<{
    key: string | null;
    draft: SessionScopeDraft;
  }>({
    key: null,
    draft: {},
  });
  const [retroactive, setRetroactive] = useState<boolean | undefined>();

  useEffect(() => {
    if (!catalog || !initializationKey) return;
    if (draftState.key === initializationKey) return;
    const initialization =
      sessionId && scope
        ? {
            draft: createSessionScopeDraft(scope, catalog),
            commit: undefined,
          }
        : createNewSessionScopeInitialization(catalog);
    setDraftState({
      key: initializationKey,
      draft: initialization.draft,
    });
    setRetroactive(sessionId ? scope?.retroactive : undefined);
    if (!sessionId) committedDraftRef.current?.(initialization.commit);
  }, [catalog, draftState.key, initializationKey, scope, sessionId]);

  const activeCatalog = catalog ?? unavailableCatalog;
  const availability = getSessionScopeAvailability(activeCatalog);
  const initialized = draftState.key === initializationKey && initializationKey !== null;
  const saveDisabled =
    !initialized ||
    !hasAvailableScopeAxis(availability) ||
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
        setDraftState({
          key: initializationKey,
          draft: createSessionScopeDraft(result, catalog),
        });
        successToast('Session scope saved');
      } else if (!sessionId) {
        successToast('Session scope configured');
      }
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Session scope could not be saved');
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

  return (
    <SessionScopeControl
      draft={draftState.draft}
      catalog={activeCatalog}
      disabled={isLoading || (Boolean(sessionId) && !scope)}
      saveDisabled={saveDisabled}
      saving={saveScope.isPending}
      retroactive={retroactive}
      onChange={(draft) => setDraftState((current) => ({ ...current, draft }))}
      onSave={handleSave}
    />
  );
}
