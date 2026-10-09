import type {
  AdminConnector,
  ConnectorConnectResult,
  ConnectorDraftInput,
  ConnectorFinalizeResult,
  ConnectorSyncResult,
} from '@kortix/sdk';

import {
  buildEasyConnectConnectorDraft,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  isAuthChallenge,
  normalizeConnectorConnectionSlug,
  proposeConnectorConnectionName,
  proposeConnectorConnectionSlug,
  type EasyConnectApp,
  type EasyConnectConnectionInput,
} from '@/features/workspace/customize/sections/connector-connection-form';

import type { InstallableVariant } from './pick-surface';

/** Who the installed account is for: the caller alone, or everyone in the project. */
export type InstallAudience = 'private' | 'project';

/** One surface of one app, as Install needs it. */
export interface InstallTarget {
  /** The app's display name. The connector and its first account are named from it. */
  appName: string;
  provider: AdminConnector['provider'];
  /** Authorization runs through a hosted Connect Link (Composio, Pipedream). */
  managed: boolean;
  /** A NEW direct connector needs a credential before it works. */
  needsCredential: boolean;
  buildDraft(input: EasyConnectConnectionInput): ConnectorDraftInput;
}

export function discoverInstallTarget(appName: string, variant: InstallableVariant): InstallTarget {
  const template = variant.template;
  const auth = template.auth
    ? {
        type: template.auth.type,
        in: template.auth.in,
        ...(template.auth.name ? { name: template.auth.name } : {}),
        ...(template.auth.prefix ? { prefix: template.auth.prefix } : {}),
      }
    : undefined;
  return {
    appName,
    provider: template.provider,
    managed: false,
    needsCredential: Boolean(template.auth) && template.auth?.type !== 'none',
    buildDraft: (input) =>
      createOnlyConnectorDraft({
        slug: input.slug,
        name: input.name.trim(),
        provider: template.provider,
        ...(template.spec ? { spec: template.spec } : {}),
        ...(template.url ? { url: template.url } : {}),
        ...(template.transport ? { transport: template.transport } : {}),
        ...(template.endpoint ? { endpoint: template.endpoint } : {}),
        ...(auth ? { auth } : {}),
      }),
  };
}

export function easyConnectInstallTarget(app: EasyConnectApp): InstallTarget {
  return {
    appName: app.name,
    provider: app.provider ?? 'pipedream',
    managed: true,
    needsCredential: false,
    buildDraft: (input) => buildEasyConnectConnectorDraft(app, input),
  };
}

/**
 * Did Install create this connector for this app and surface?
 *
 * STRICT, because the answer decides where a new account is authorized. Three
 * things must hold:
 * - the provider matches;
 * - the slug is exactly what `proposeConnectorConnectionSlug` builds for the
 *   app's name, `<normalized name>-<6 base36>`, never a prefix;
 * - the display name is what `proposeConnectorConnectionName` gives: the app's
 *   name, or `<App> <n>` with n an integer of 2 or more. A six-character word
 *   reads as a random suffix (`notion-search`, `google-sheets`), and the name
 *   is what tells those apart.
 *
 * A renamed connector is therefore not reused. That miss costs a second
 * connector, which is the cheap failure. A false hit would authorize the
 * wrong app.
 */
export function connectorInstalledFrom(
  connector: Pick<AdminConnector, 'slug' | 'provider' | 'name'>,
  appName: string,
  provider: AdminConnector['provider'],
): boolean {
  if (connector.provider !== provider) return false;
  const base = normalizeConnectorConnectionSlug(appName).replace(/[-_]+$/g, '');
  if (!base || !connector.slug.startsWith(`${base}-`)) return false;
  if (!/^[a-z0-9]{6}$/.test(connector.slug.slice(base.length + 1))) return false;
  const app = appName.trim().toLowerCase();
  const name = (connector.name ?? '').trim().toLowerCase();
  if (!app || !name) return false;
  if (name === app) return true;
  if (!name.startsWith(`${app} `)) return false;
  const ordinal = name.slice(app.length + 1);
  return /^[1-9][0-9]*$/.test(ordinal) && Number(ordinal) >= 2;
}

/**
 * The name a new account gets: the app's name, then `<name> 2`, `<name> 3`.
 * `POST /connections` with a label an account of the same owner already uses
 * updates that account instead of adding one, so the label must be free.
 */
export function proposeAccountLabel(appName: string, taken: readonly string[]): string {
  const used = new Set(taken.map((label) => label.trim().toLowerCase()));
  const name = appName.trim();
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export interface InstallDeps {
  createConnector(
    projectId: string,
    draft: ConnectorDraftInput,
  ): Promise<{ sync?: ConnectorSyncResult }>;
  /** Labels of the accounts a connector already has. */
  listAccountLabels(projectId: string, connectorSlug: string): Promise<string[]>;
  reconcileMine(
    projectId: string,
    input: { connector_alias: string; label: string },
  ): Promise<{ connection_id: string }>;
  reconcileProject(
    projectId: string,
    input: { connector_alias: string; owner_type: 'project'; label: string },
  ): Promise<{ connection_id: string }>;
  connectConnection(projectId: string, connectionId: string): Promise<ConnectorConnectResult>;
  finalizeConnection(projectId: string, connectionId: string): Promise<ConnectorFinalizeResult>;
  /** The project-owned managed connect, with its shared-default fallback. */
  projectSteps(
    projectId: string,
    slug: string,
    label: string,
  ): {
    start: () => Promise<ConnectorConnectResult>;
    finalize: () => Promise<ConnectorFinalizeResult>;
  };
  /** Opens the provider window SYNCHRONOUSLY, then runs `start` and polls `finalize`. */
  runLinkFlow(
    start: () => Promise<ConnectorConnectResult>,
    finalize: () => Promise<ConnectorFinalizeResult>,
  ): Promise<{ connected: true }>;
  /** Slug suffix source; injectable so tests are deterministic. */
  random?: () => string;
}

export type InstallResult =
  | { status: 'connected'; slug: string }
  | { status: 'needs_credential'; slug: string; connectionId: string }
  /** An MCP server that signs in with OAuth: start that sign-in now. */
  | { status: 'sign_in'; slug: string; connectionId: string }
  | { status: 'sync_failed'; name: string; error: string };

class InstallSyncError extends Error {
  constructor(
    readonly connectorName: string,
    readonly syncError: string,
  ) {
    super(syncError);
  }
}

export async function runInstall(
  deps: InstallDeps,
  input: {
    projectId: string;
    target: InstallTarget;
    audience: InstallAudience;
    connectors: readonly (Pick<AdminConnector, 'slug' | 'provider' | 'name' | 'authSecret'> &
      Partial<Pick<AdminConnector, 'status'>>)[];
  },
): Promise<InstallResult> {
  const { projectId, target, audience, connectors } = input;
  const existing =
    connectors.find((connector) =>
      connectorInstalledFrom(connector, target.appName, target.provider),
    ) ?? null;

  // An MCP server that signs in with OAuth answers its first tools/list with
  // 401 or 403. That is the sign-in still to do, not a broken install.
  let signInPending = false;

  /** The connector to add the account to, created when the project has none. */
  const ensureConnector = async (): Promise<{ slug: string; label: string }> => {
    if (existing) {
      const labels = await deps.listAccountLabels(projectId, existing.slug);
      return { slug: existing.slug, label: proposeAccountLabel(target.appName, labels) };
    }
    const slugs = connectors.map((connector) => connector.slug);
    const slug = proposeConnectorConnectionSlug(target.appName, slugs, deps.random);
    const name = proposeConnectorConnectionName(target.appName, slugs);
    const result = await deps.createConnector(projectId, target.buildDraft({ slug, name }));
    const syncError = connectorSyncErrorForSlug(result, slug);
    if (syncError && target.provider === 'mcp' && isAuthChallenge(syncError)) {
      signInPending = true;
    } else if (syncError) {
      throw new InstallSyncError(name, syncError);
    }
    return { slug, label: proposeAccountLabel(target.appName, []) };
  };

  try {
    if (target.managed) {
      let slug = '';
      let finalize: (() => Promise<ConnectorFinalizeResult>) | null = null;
      // No `await` before this call: `runLinkFlow` opens the provider window
      // inside the click, and a window opened after an await is blocked.
      await deps.runLinkFlow(
        async () => {
          const connector = await ensureConnector();
          slug = connector.slug;
          if (audience === 'project') {
            const steps = deps.projectSteps(projectId, connector.slug, connector.label);
            finalize = steps.finalize;
            return steps.start();
          }
          const connection = await deps.reconcileMine(projectId, {
            connector_alias: connector.slug,
            label: connector.label,
          });
          finalize = () => deps.finalizeConnection(projectId, connection.connection_id);
          return deps.connectConnection(projectId, connection.connection_id);
        },
        () => {
          if (!finalize) throw new Error('The account was not created.');
          return finalize();
        },
      );
      return { status: 'connected', slug };
    }

    const connector = await ensureConnector();
    const connection =
      audience === 'private'
        ? await deps.reconcileMine(projectId, {
            connector_alias: connector.slug,
            label: connector.label,
          })
        : await deps.reconcileProject(projectId, {
            connector_alias: connector.slug,
            owner_type: 'project',
            label: connector.label,
          });
    const needsCredential = existing
      ? Boolean(existing.authSecret) ||
        existing.status === 'error' ||
        existing.status === 'needs_auth'
      : target.needsCredential || signInPending;
    if (!needsCredential) return { status: 'connected', slug: connector.slug };
    // An MCP account signs in through the server's own OAuth when it has one;
    // the caller falls back to credential entry when it does not.
    if (target.provider === 'mcp') {
      return { status: 'sign_in', slug: connector.slug, connectionId: connection.connection_id };
    }
    return {
      status: 'needs_credential',
      slug: connector.slug,
      connectionId: connection.connection_id,
    };
  } catch (error) {
    if (error instanceof InstallSyncError) {
      return { status: 'sync_failed', name: error.connectorName, error: error.syncError };
    }
    throw error;
  }
}
