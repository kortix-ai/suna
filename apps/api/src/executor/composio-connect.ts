import type { ComposioToolkitSession } from './composio';
import type { ConnectorDraft, CrudResult } from './manifest-crud';
import type { SyncResult } from './sync';

export interface ConnectComposioToolkitInput {
  projectId: string;
  accountId: string;
  toolkitSlug: string;
  connectorSlug: string;
  name: string;
  callbackUrl: string;
  apiKey: string;
}

export type ConnectComposioToolkitResult =
  | {
      ok: true;
      connectorSlug: string;
      connected: boolean;
      authorizationUrl: string | null;
      sync: SyncResult;
    }
  | { ok: false; error: string; status: number };

interface ConnectComposioToolkitDeps {
  createSession(input: {
    projectId: string;
    toolkitSlug: string;
    callbackUrl: string;
  }): Promise<ComposioToolkitSession>;
  authorizeSession(input: {
    sessionId: string;
    toolkitSlug: string;
    callbackUrl: string;
  }): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  createConnector(projectId: string, accountId: string, draft: ConnectorDraft): Promise<CrudResult>;
  setCredential(
    projectId: string,
    connectorSlug: string,
    input: { value: string },
  ): Promise<CrudResult>;
  syncConnectors(projectId: string, accountId: string): Promise<SyncResult>;
  deleteConnector(projectId: string, connectorSlug: string): Promise<CrudResult>;
}

export async function connectComposioToolkitConnector(
  input: ConnectComposioToolkitInput,
  deps: ConnectComposioToolkitDeps,
): Promise<ConnectComposioToolkitResult> {
  const session = await deps.createSession({
    projectId: input.projectId,
    toolkitSlug: input.toolkitSlug,
    callbackUrl: input.callbackUrl,
  });
  let connectorCreated = false;

  const rollback = async () => {
    if (connectorCreated) {
      await deps.deleteConnector(input.projectId, input.connectorSlug).catch(() => undefined);
    }
    await deps.deleteSession(session.sessionId).catch(() => undefined);
  };

  try {
    const created = await deps.createConnector(input.projectId, input.accountId, {
      slug: input.connectorSlug,
      name: input.name,
      provider: 'mcp',
      url: session.mcpUrl,
      transport: 'http',
      authorization_strategy: 'project',
      create_only: true,
      auth: {
        type: 'api_key',
        in: 'header',
        name: session.credentialHeaderName,
      },
    });
    if (!created.ok) {
      await rollback();
      return created;
    }
    connectorCreated = true;

    const credential = await deps.setCredential(input.projectId, input.connectorSlug, {
      value: input.apiKey,
    });
    if (!credential.ok) {
      await rollback();
      return credential;
    }

    const sync = await deps.syncConnectors(input.projectId, input.accountId);
    if (sync.errors.some((error) => error.slug === input.connectorSlug)) {
      await rollback();
      return {
        ok: false,
        error: 'Composio connector could not synchronize',
        status: 502,
      };
    }

    try {
      const authorizationUrl = session.requiresAuthorization
        ? await deps.authorizeSession({
            sessionId: session.sessionId,
            toolkitSlug: input.toolkitSlug,
            callbackUrl: input.callbackUrl,
          })
        : null;
      return {
        ok: true,
        connectorSlug: input.connectorSlug,
        connected: !session.requiresAuthorization,
        authorizationUrl,
        sync,
      };
    } catch {
      await rollback();
      return {
        ok: false,
        error: 'Composio authorization could not start',
        status: 502,
      };
    }
  } catch (error) {
    await rollback();
    throw error;
  }
}
