'use client';

/**
 * The session-scope draft state machine: what a save actually sends, and what a
 * pre-create session commits for its first prompt. The composer surface that
 * renders it lives in `features/session/overrides`.
 */
import type { SessionScope, SessionScopeInput } from '@kortix/sdk';

import {
  buildSessionScopeReplacement,
  createNewSessionScopeDraft,
  type SessionScopeAvailability,
  type SessionScopeCommit,
  type SessionScopeDraft,
  type SessionScopeSelectionCatalog,
} from './session-scope-model';

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
    connector_bindings: catalog.connector_connections.status === 'ready',
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
        const connectionId = binding.connection_id;
        if (!connectionId) {
          throw new Error(`Connector ${alias} is missing connection_id.`);
        }
        return [alias, { connection_id: connectionId }];
      }),
    );
  }
  if (Object.hasOwn(replacement, 'require_connectors')) {
    // Carried through, or the canonical draft silently forgets every connector
    // the user required without connecting — the toolbar would re-render with
    // the box unchecked right after they checked it.
    draft.require_connectors = [...(replacement.require_connectors ?? [])];
  }
  return draft;
}

function canonicalCommittedDraft(
  replacement: SessionScopeInput,
  source: SessionScopeDraft,
): SessionScopeDraft {
  const draft = canonicalDraftFromReplacement(replacement);
  if (source.connector_bindings_inherited && source.connector_bindings !== undefined) {
    draft.connector_bindings = Object.fromEntries(
      Object.entries(source.connector_bindings).map(([alias, binding]) => [
        alias,
        { connection_id: binding.connection_id },
      ]),
    );
    draft.connector_bindings_inherited = true;
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
      draft: canonicalCommittedDraft(replacement, draft),
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
      draft: canonicalCommittedDraft(replacement, draft),
      availability,
    });
    return undefined;
  }
  if (!previousScope) {
    throw new Error('The current session scope is required before replacement.');
  }
  return replaceScope(replacement);
}
