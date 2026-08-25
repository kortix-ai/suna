'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { connectorConnect, connectorFinalize, listSessionConnectRequests } from '@kortix/sdk';

import { errorToast, successToast } from '@/components/ui/toast';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';

export function sessionConnectRequestsKey(projectId: string, sessionId: string) {
  return ['session-connect-requests', projectId, sessionId] as const;
}

/**
 * The connectors this session's agent is blocked on.
 *
 * Polled rather than pushed: the request is written by the API when the agent
 * calls connect, and there is no session-stream part for it. 20s is slower than
 * a human can read the agent's message and reach for the button, and the query
 * also refetches on focus — which covers the real path back from a popup.
 */
export function useSessionConnectRequests(
  projectId: string | undefined,
  sessionId: string | undefined,
) {
  return useQuery({
    queryKey: sessionConnectRequestsKey(projectId ?? '', sessionId ?? ''),
    queryFn: () => listSessionConnectRequests(projectId!, sessionId!),
    enabled: !!projectId && !!sessionId,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    // A route an older API deployment does not serve must render nothing, not a
    // red banner over a session that is otherwise fine.
    retry: false,
  });
}

/**
 * Connect one of them, through the same popup + poll flow project settings uses.
 *
 * Deliberately the CONNECTOR-scoped routes, not the connection-scoped pair the
 * settings gate uses: only the connector-scoped finalize knows which session
 * asked, and it is the one that tells that agent the account landed. Sending
 * this through the connection-scoped route would connect the account and leave
 * the agent waiting for a "done" nobody types.
 */
export function useSessionConnectorConnect(projectId: string, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      runConnectLinkFlow(
        () => connectorConnect(projectId, slug),
        () => connectorFinalize(projectId, slug),
      ),
    onSuccess: (result) => {
      if (!result.connected) return;
      successToast('Connected — picking the task back up');
      void queryClient.invalidateQueries({
        queryKey: sessionConnectRequestsKey(projectId, sessionId),
      });
    },
    onError: (error: Error) => errorToast(error.message),
  });
}
