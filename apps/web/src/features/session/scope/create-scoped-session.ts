import type { SessionScope, SessionScopeInput } from '@kortix/sdk';

import {
  buildSessionScopeReplacement,
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
    const currentScope = await input.readScope(sessionId);
    const replacement = buildSessionScopeReplacement(input.draft, currentScope, input.availability);
    if (Object.keys(replacement).length > 0) {
      await input.replaceScope(sessionId, replacement);
    }
  }
  await input.onReady(sessionId);
  return sessionId;
}
