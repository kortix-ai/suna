'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';

import { errorToast, successToast } from '@/components/ui/toast';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';
import {
  type ConnectorConnectResult,
  type ConnectorFinalizeResult,
  connectorConnect,
  connectorFinalize,
} from '@kortix/sdk';

export interface AppConnectDeps {
  connectProject: typeof connectorConnect;
  finalizeProject: typeof connectorFinalize;
}

/**
 * The `start`/`finalize` pair for the project's shared account.
 *
 * `owner: 'project'` is required on BOTH verbs. Both connector-scoped routes
 * default an ABSENT owner to `me`
 * (`apps/api/src/projects/lib/connection-access.ts:94`, applied at
 * `apps/api/src/connectors/db-deps.ts:2325` and `:2439`), which runs
 * `ensureMemberConnection` and lands `owner_type = 'member'`, `owner_id =`
 * whoever clicked — an account reachable by that one user and never by a
 * service account (`connectionIsReachable`, `connection-access.ts:42`). The
 * owner must also MATCH across the two verbs, because finalize selects the row
 * by owner scope. Same rule as `projectConnectSteps` in
 * `use-pipedream-connect-project.ts` and `toolConnectSteps` in
 * `use-tool-connect.ts`, where the member-owned outcome was verified live.
 */
export function appConnectSteps(
  projectId: string,
  slug: string,
  deps: AppConnectDeps,
): {
  start: () => Promise<ConnectorConnectResult>;
  finalize: () => Promise<ConnectorFinalizeResult>;
} {
  let connectionId: string | null = null;

  return {
    start: async () => {
      const result = await deps.connectProject(projectId, slug, { owner: 'project' });
      connectionId = result.connectionId ?? null;
      return result;
    },
    finalize: () =>
      deps.finalizeProject(projectId, slug, {
        owner: 'project',
        ...(connectionId ? { connectionId } : {}),
      }),
  };
}

const sdkAppConnectDeps: AppConnectDeps = {
  connectProject: connectorConnect,
  finalizeProject: connectorFinalize,
};

/**
 * Connect the project's shared account for a connector.
 */
export function usePipedreamConnect(projectId: string, slug: string, onConnected: () => void) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return useMutation({
    mutationFn: async () => {
      const steps = appConnectSteps(projectId, slug, sdkAppConnectDeps);
      return runConnectLinkFlow(steps.start, steps.finalize);
    },
    onSuccess: (res) => {
      if (!res.connected) return;
      successToast(tI18nComplete.raw('text22965568d22a'));
      onConnected();
    },
    onError: (err: Error) => errorToast(err.message),
  });
}
