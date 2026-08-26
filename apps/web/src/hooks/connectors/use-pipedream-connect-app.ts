'use client';

import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast } from '@/components/ui/toast';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';
import { pipedreamConnect, pipedreamFinalize } from '@kortix/sdk';

/**
 * Connect the project's shared account for a connector.
 */
export function usePipedreamConnect(projectId: string, slug: string, onConnected: () => void) {
  return useMutation({
    mutationFn: async () => {
      return runConnectLinkFlow(
        () => pipedreamConnect(projectId, slug),
        () => pipedreamFinalize(projectId, slug),
      );
    },
    onSuccess: (res) => {
      if (!res.connected) return;
      successToast('Connected');
      onConnected();
    },
    onError: (err: Error) => errorToast(err.message),
  });
}
