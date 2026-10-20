import type { QueryClient } from '@tanstack/react-query';

/**
 * What a share changes besides who can open the session: its pooled provider
 * keys.
 *
 * The gateway uses nobody's personal keys in a shared session, so the API
 * switches a selection the shared session could not use to the keys shared
 * with the whole project (`PUT /projects/:id/sessions/:id/sharing`). The
 * Provider keys panel reads the selection from `useSessionProviderSecretPools`
 * (@kortix/sdk/react), whose key sits outside `qk.project.sessionsScope`, so
 * the share dialog's session refresh never reached it. The panel kept the
 * pre-share selection and showed it as "unavailable"; saving that stale view
 * would store an empty selection and stop the session's model.
 */
export function refreshAfterShare(queryClient: QueryClient, projectId: string, sessionId: string) {
  return queryClient.invalidateQueries({ queryKey: ['session-provider-secret-pools', projectId, sessionId] });
}
