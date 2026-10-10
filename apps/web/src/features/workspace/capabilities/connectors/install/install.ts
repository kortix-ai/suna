import type {
  AdminConnector,
  ConnectorDraftInput,
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
  /** Slug suffix source; injectable so tests are deterministic. */
  random?: () => string;
}

export type InstallResult =
  | { status: 'installed'; slug: string }
  | { status: 'sync_failed'; name: string; error: string };

/**
 * Install = add the connector PROFILE to the project, nothing more.
 *
 * A profile is always the project's: the app, its config and its rules (a
 * `kortix.yaml` entry). Who may use it is a property of each ACCOUNT, chosen
 * when one is added (`useAddAccount`), never here. When the project already
 * has a profile for this app and surface, Install reuses it.
 */
export async function runInstall(
  deps: InstallDeps,
  input: {
    projectId: string;
    target: InstallTarget;
    connectors: readonly Pick<AdminConnector, 'slug' | 'provider' | 'name'>[];
  },
): Promise<InstallResult> {
  const { projectId, target, connectors } = input;
  const existing = connectors.find((connector) =>
    connectorInstalledFrom(connector, target.appName, target.provider),
  );
  if (existing) return { status: 'installed', slug: existing.slug };
  const slugs = connectors.map((connector) => connector.slug);
  const slug = proposeConnectorConnectionSlug(target.appName, slugs, deps.random);
  const name = proposeConnectorConnectionName(target.appName, slugs);
  const result = await deps.createConnector(projectId, target.buildDraft({ slug, name }));
  const syncError = connectorSyncErrorForSlug(result, slug);
  // An MCP server that signs in with OAuth answers its first tools/list with
  // 401 or 403: that is the sign-in still to do, not a broken install.
  if (syncError && !(target.provider === 'mcp' && isAuthChallenge(syncError))) {
    return { status: 'sync_failed', name, error: syncError };
  }
  return { status: 'installed', slug };
}
