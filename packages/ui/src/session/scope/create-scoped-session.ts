import type { SessionScope, SessionScopeInput } from '@kortix/sdk';

import {
  buildSessionScopeReplacement,
  scopeReplacementIsFreshDefault,
  type SessionScopeAvailability,
  type SessionScopeDraft,
} from './session-scope-model';

interface CreateScopedSessionInput {
  create: () => Promise<string>;
  draft?: SessionScopeDraft;
  availability?: SessionScopeAvailability;
  readScope: (sessionId: string) => Promise<SessionScope>;
  replaceScope: (sessionId: string, replacement: SessionScopeInput) => Promise<unknown>;
  onReady: (sessionId: string) => void | Promise<void>;
}

function hasDraftReplacement(draft: SessionScopeDraft | undefined): draft is SessionScopeDraft {
  if (!draft) return false;
  return (
    (Object.hasOwn(draft, 'secrets') && draft.secrets !== undefined) ||
    (Object.hasOwn(draft, 'connector_bindings') && draft.connector_bindings !== undefined)
  );
}

export async function createScopedSession(input: CreateScopedSessionInput): Promise<string> {
  const sessionId = await input.create();
  if (hasDraftReplacement(input.draft)) {
    // The session was just created, so its scope IS the fresh default. A
    // replacement that only restates that default replaces nothing — skip the
    // read + write instead of spending two serial round trips between the
    // warm-claim and /start on every untouched send. Built without a previous
    // scope on purpose: at creation there is no previous scope beyond the
    // default, and the draft carries every axis it intends to set.
    const provisional = buildSessionScopeReplacement(input.draft, undefined, input.availability);
    if (!scopeReplacementIsFreshDefault(provisional)) {
      const currentScope = await input.readScope(sessionId);
      const replacement = buildSessionScopeReplacement(
        input.draft,
        currentScope,
        input.availability,
      );
      if (Object.keys(replacement).length > 0) {
        await input.replaceScope(sessionId, replacement);
      }
    }
  }
  await input.onReady(sessionId);
  return sessionId;
}
