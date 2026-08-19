'use client';

import { createFrontendClient } from '@pipedream/sdk/browser';
import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast } from '@/components/ui/toast';
import { pipedreamConnect, pipedreamFinalize } from '@kortix/sdk';

import { withPipedreamOverlayEscape } from '@/hooks/connectors/use-pipedream-connect-member';

/**
 * Connect the PROJECT's shared account for a Pipedream connector — the 1-click
 * "App" flow. Sibling of `usePipedreamConnectMember` (private, per-user) and
 * `usePipedreamConnectProject` (a labelled additional project connection).
 *
 * Lifted out of `customize/sections/connectors-view.tsx`, which is 5,219 lines
 * and 50 components. That module exported this hook beside its components, so
 * (a) React Fast Refresh could not hot-update it — every edit forced a full
 * page reload — and (b) any consumer importing just this hook pulled the whole
 * module and its 55 imports (`HighlightedCode`, `PoliciesPanel`,
 * `DiscoverCatalogue`, `ConnectorConnectionModal`) into its route chunk.
 */
export function usePipedreamConnect(projectId: string, slug: string, onConnected: () => void) {
  return useMutation({
    mutationFn: async () => {
      const { token, app } = await pipedreamConnect(projectId, slug);
      if (!token || !app) throw new Error('App connect is not configured');
      const pd = createFrontendClient({
        externalUserId: `${projectId}:${slug}`,
        tokenCallback: async () => ({ token, connect_link_url: undefined, expires_at: '' }) as any,
      });
      const release = withPipedreamOverlayEscape();
      let connected = false;
      try {
        connected = await new Promise<boolean>((resolve, reject) => {
          pd.connectAccount({
            app,
            token,
            onSuccess: () => resolve(true),
            onClose: (status: { successful: boolean }) => resolve(status.successful),
            onError: (err: unknown) =>
              reject(new Error((err as Error)?.message || 'Connection cancelled')),
          });
        });
      } finally {
        release();
      }
      if (!connected) return { connected: false };
      await pipedreamFinalize(projectId, slug);
      return { connected: true };
    },
    onSuccess: (res) => {
      if (!res.connected) return;
      successToast('Connected');
      onConnected();
    },
    onError: (err: Error) => errorToast(err.message),
  });
}
