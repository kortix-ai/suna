'use client';

import { useAuthenticatedPreviewUrl } from '@kortix/sdk/react';
import { parseLocalhostUrl } from '@kortix/sdk';

import { useUiPreviewUrlResolver } from '../../providers/ui-provider';
import { useHostPreviewUrl, type HostPreviewUrl } from '../../providers/use-host-preview-url';
import { useSessionIds } from '../../providers/session-ids';

/**
 * The URL a session frame loads for a sandbox address (`http://localhost:<port>/…`).
 * With a host resolver (`UiProvider resolvePreviewUrl`) the host returns the final
 * URL with its own scoped credentials, so the SDK token never lands in the frame
 * URL. Without one, the SDK appends its token to `proxiedUrl`.
 * `url` is null while either path resolves, and after the host resolver failed.
 */
export function usePreviewFrameUrl(
  localUrl: string,
  proxiedUrl: string,
  ids?: { projectId?: string; sessionId?: string },
): HostPreviewUrl {
  const scope = useSessionIds();
  const projectId = ids?.projectId ?? scope.projectId;
  const sessionId = ids?.sessionId ?? scope.sessionId;
  const parsed = localUrl ? parseLocalhostUrl(localUrl) : null;
  const host = useHostPreviewUrl(
    useUiPreviewUrlResolver(),
    localUrl && projectId && sessionId
      ? { projectId, sessionId, port: parsed?.port ?? 0, path: parsed?.path || '/', url: localUrl }
      : null,
  );
  const sdkUrl = useAuthenticatedPreviewUrl(host.handled ? '' : proxiedUrl);
  return host.handled ? host : { handled: false, url: sdkUrl, failed: false };
}
