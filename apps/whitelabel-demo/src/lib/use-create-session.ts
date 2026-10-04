'use client';

/**
 * The one session-create mutation, used by the new-session dialog, the project
 * home, and the scope bar.
 *
 * Each KaaB refusal has a distinct code and a different person who can fix it —
 * collapsing them into one string throws that away, so every failure goes
 * through the shared classifier (`sessionCreateFailure`). There is no
 * create-time connector pre-flight any more: a session can never be refused for
 * an unconnected connector, the gate moved to the connector CALL, which the
 * agent's own turn handles and reports on with a connect link.
 */

import { kortix } from '@/lib/kortix';
import { invalidateSessions } from '@/lib/query-keys';
import { sessionCreateFailure } from '@/lib/session-create-failure';
import {
  buildSessionCreateInput,
  type SessionOverrides,
} from '@/lib/session-overrides';
import { generateSessionId } from '@kortix/sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/** The create this hook sends: overrides plus the optional body extras. */
interface CreateSessionCall {
  overrides: SessionOverrides;
  name?: string;
  sandboxSlug?: string;
}

/**
 * Create a session and route to it. `input` builds the body from whatever the
 * caller's state is at mutate time; unset overrides are omitted by the builder
 * rather than guessed. On success the project's session queries are
 * invalidated, then `onCreated` runs (navigate, close a dialog, stash a
 * prompt).
 */
export function useCreateSession<TVars>(
  projectId: string,
  options: {
    input: (vars: TVars) => CreateSessionCall;
    onCreated?: (sessionId: string, vars: TVars) => void;
  },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => {
      const sessionId = generateSessionId();
      const { overrides, name, sandboxSlug } = options.input(vars);
      await kortix
        .project(projectId)
        .sessions.create(
          buildSessionCreateInput(overrides, { sessionId, name, sandboxSlug }),
        );
      return sessionId;
    },
    onSuccess: (sessionId, vars) => {
      invalidateSessions(qc, projectId);
      options.onCreated?.(sessionId, vars);
    },
    onError: (err) => {
      const failure = sessionCreateFailure(err);
      toast.error(failure.title, { description: failure.detail });
    },
  });
}
