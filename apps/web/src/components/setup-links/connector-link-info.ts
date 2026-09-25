'use client';

import { getConnectorSetupLink, type ConnectorSetupLinkInfo } from '@kortix/sdk';
import { useEffect, useState } from 'react';

import { setupLinkApiBase } from './util';

/**
 * One in-flight or settled GET per link token, shared by every card that shows
 * it. A message can hold several connect cards, and the same link can appear in
 * a streaming and a settled render of one message; without this each would ask
 * the rate-limited public route on its own.
 *
 * A rejected request is dropped from the cache, so a card mounted after a blip
 * asks again instead of inheriting the failure.
 */
export function createConnectorLinkInfoCache(
  fetchInfo: (token: string) => Promise<ConnectorSetupLinkInfo>,
) {
  const entries = new Map<string, Promise<ConnectorSetupLinkInfo>>();
  return {
    load(token: string): Promise<ConnectorSetupLinkInfo> {
      const cached = entries.get(token);
      if (cached) return cached;
      const request = fetchInfo(token).catch((cause: unknown) => {
        entries.delete(token);
        throw cause;
      });
      entries.set(token, request);
      return request;
    },
  };
}

const sharedCache = createConnectorLinkInfoCache((token) =>
  getConnectorSetupLink(token, { backendUrl: setupLinkApiBase() }),
);

/**
 * The words a connect card leads with: the app's display name, then the
 * provider app id, then the slug. `project` is null when the server did not
 * name one — the API answers "this project" for a project it cannot find.
 */
export function connectorHeadline(info: ConnectorSetupLinkInfo): {
  app: string;
  project: string | null;
} {
  const project = info.project_name?.trim();
  return {
    app: info.name?.trim() || info.app?.trim() || info.slug,
    project: project && project !== 'this project' ? project : null,
  };
}

/**
 * What a connect link names, for the card that renders it. `null` until the
 * GET answers, and on failure: the card then keeps the agent's own label and
 * the modal reports the error when opened.
 */
export function useConnectorLinkInfo(token: string | null): ConnectorSetupLinkInfo | null {
  const [info, setInfo] = useState<{ token: string; value: ConnectorSetupLinkInfo } | null>(null);

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    sharedCache.load(token).then(
      (value) => {
        if (!cancelled) setInfo({ token, value });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  return info && info.token === token ? info.value : null;
}
