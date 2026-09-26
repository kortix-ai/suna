/**
 * One click on an app in onboarding: add it to the project as a connector,
 * then sign in to it as the project's shared account.
 *
 * The popup opens first, inside the click, before any request: a browser only
 * allows a popup that opens synchronously from a user action. So the connector
 * is created inside the flow's `start`, after the popup is already open.
 */

import {
  connectorConnect,
  connectorFinalize,
  createConnector,
  type ConnectorConnectResult,
  type ConnectorDraftInput,
  type ConnectorFinalizeResult,
} from '@kortix/sdk';

import {
  buildEasyConnectConnectorDraft,
  connectorSyncErrorForSlug,
  proposeConnectorConnectionSlug,
  randomConnectorSlugSuffix,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';
import { toolConnectSteps } from '@/hooks/connectors/use-tool-connect';

export interface CatalogApp {
  slug: string;
  name: string;
  provider: 'composio' | 'pipedream';
}

export interface ConnectAppDeps {
  create: (projectId: string, draft: ConnectorDraftInput) => Promise<unknown>;
  start: () => Promise<ConnectorConnectResult>;
  finalize: () => Promise<ConnectorFinalizeResult>;
  runFlow: (
    start: () => Promise<ConnectorConnectResult>,
    finalize: () => Promise<ConnectorFinalizeResult>,
  ) => Promise<{ connected: true }>;
}

/** The connector slug for an app: the one a first attempt chose, else a new one. */
export function connectionSlugFor(
  app: Pick<CatalogApp, 'name'>,
  previous: string | undefined,
  existingSlugs: readonly string[],
  random: () => string = randomConnectorSlugSuffix,
): string {
  return previous ?? proposeConnectorConnectionSlug(app.name, existingSlugs, random);
}

export function sdkConnectAppDeps(projectId: string, connectorSlug: string): ConnectAppDeps {
  const steps = toolConnectSteps(projectId, connectorSlug, {
    connectProject: connectorConnect,
    finalizeProject: connectorFinalize,
  });
  return {
    create: createConnector,
    start: steps.start,
    finalize: steps.finalize,
    runFlow: runConnectLinkFlow,
  };
}

/**
 * Resolves once the account is connected. Rejects when the popup closes, the
 * sign-in fails, or the manifest refuses the connector. `onCreated` fires as
 * soon as the connector exists, so a retry reuses it instead of adding a
 * second one.
 */
export async function connectApp(
  input: { projectId: string; app: CatalogApp; connectorSlug: string; created: boolean },
  deps: ConnectAppDeps = sdkConnectAppDeps(input.projectId, input.connectorSlug),
  onCreated?: () => void,
): Promise<void> {
  const { projectId, app, connectorSlug, created } = input;
  await deps.runFlow(async () => {
    if (!created) {
      const draft = buildEasyConnectConnectorDraft(app, { name: app.name, slug: connectorSlug });
      const result = (await deps.create(projectId, draft)) as Parameters<
        typeof connectorSyncErrorForSlug
      >[0];
      const syncError = connectorSyncErrorForSlug(result ?? {}, connectorSlug);
      if (syncError) throw new Error(syncError);
      onCreated?.();
    }
    return deps.start();
  }, deps.finalize);
}
