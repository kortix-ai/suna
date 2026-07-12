'use client';

import { useMutation } from '@tanstack/react-query';

import { createConnector, pipedreamConnect, pipedreamFinalize } from '@kortix/sdk/projects-client';

import { toast } from '@/lib/toast';

const PIPEDREAM_IFRAME_SELECTOR = 'iframe[id^="pipedream-connect-iframe-"]';

function withPipedreamOverlayEscape(): () => void {
  if (typeof document === 'undefined') return () => {};
  const releasePointerEvents = () => {
    document.querySelectorAll<HTMLIFrameElement>(PIPEDREAM_IFRAME_SELECTOR).forEach((el) => {
      el.style.pointerEvents = 'auto';
    });
  };
  const observer = new MutationObserver(releasePointerEvents);
  observer.observe(document.body, { childList: true });
  releasePointerEvents();

  const isPipedreamFrame = (node: EventTarget | null): boolean =>
    node instanceof Element && node.matches(PIPEDREAM_IFRAME_SELECTOR);
  const guardFocus = (event: FocusEvent) => {
    if (isPipedreamFrame(event.target) || isPipedreamFrame(event.relatedTarget)) {
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener('focusin', guardFocus, true);
  document.addEventListener('focusout', guardFocus, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', guardFocus, true);
    document.removeEventListener('focusout', guardFocus, true);
  };
}

export function useToolConnect(projectId: string, onConnected: () => void) {
  return useMutation({
    mutationFn: async (slug: string) => {
      try {
        await createConnector(projectId, {
          slug,
          provider: 'pipedream',
          app: slug,
          account: 'default',
          credential: 'shared',
        });
      } catch {
      }

      const { token, app } = await pipedreamConnect(projectId, slug);
      if (!token || !app) throw new Error('This app is not available to connect right now');

      const { createFrontendClient } = await import('@pipedream/sdk/browser');
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

      if (!connected) return { slug, connected: false };
      await pipedreamFinalize(projectId, slug);
      return { slug, connected: true };
    },
    onSuccess: (res) => {
      if (!res.connected) return;
      toast.success('Connected');
      onConnected();
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
