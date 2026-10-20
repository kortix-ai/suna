import type { ConnectorDraftInput } from '@kortix/sdk';

import {
  isAuthChallenge,
  normalizeConnectorConnectionSlug,
} from '../../sections/connector-connection-form';

/** Host labels that name the protocol or the hosting, not the service. */
const GENERIC_LABELS = new Set(['mcp', 'api', 'www', 'remote', 'server', 'app', 'gateway']);
/** Second-level labels of a two-part public suffix (`co.uk`, `com.au`). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);

/**
 * The connector slug and display name for an MCP server, from its URL:
 * `https://mcp.linear.app/mcp` → `linear` / `Linear`. A taken slug gets the
 * next free number. Null for anything that is not an http(s) URL.
 */
export function mcpServerIdentity(
  rawUrl: string,
  takenSlugs: readonly string[],
): { slug: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const labels = url.hostname.toLowerCase().split('.').filter(Boolean);
  if (labels.length > 1) labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1]!)) labels.pop();
  const base =
    [...labels].reverse().find((label) => !GENERIC_LABELS.has(label)) ?? labels[labels.length - 1] ?? 'mcp';
  const root = normalizeConnectorConnectionSlug(base) || 'mcp';
  let slug = root;
  for (let n = 2; takenSlugs.includes(slug); n++) slug = `${root}-${n}`;
  const name = root.charAt(0).toUpperCase() + root.slice(1);
  return { slug, name };
}

/**
 * A catalogue app's connector is named after the app, not after its MCP host:
 * `gmailmcp.googleapis.com` would name every Google app "Googleapis".
 */
export function mcpAppIdentity(
  appName: string,
  takenSlugs: readonly string[],
): { slug: string; name: string } {
  const root = normalizeConnectorConnectionSlug(appName) || 'mcp';
  let slug = root;
  for (let n = 2; takenSlugs.includes(slug); n++) slug = `${root}-${n}`;
  return { slug, name: appName };
}

export type Grantee = { type: 'user' | 'group' | 'service_account'; id: string };

export interface AddMcpServerDeps {
  /** Creates the connector and runs its first sync (`createConnectorWithOptionalOAuth2`). */
  createConnector: (
    projectId: string,
    draft: ConnectorDraftInput,
  ) => Promise<{ syncError: string | null; signInPending: boolean }>;
  /** The caller's own account ("Only you"). */
  createMemberAccount: (
    projectId: string,
    input: { connector_alias: string; label: string },
  ) => Promise<{ connection_id: string }>;
  /** The project's shared account: the one the connector was made with, or a new one. */
  projectAccount: (projectId: string, slug: string, label: string) => Promise<{ connection_id: string }>;
  /** Narrows a shared account to the picked people, groups and agents. */
  grantAccess: (projectId: string, connectionId: string, grantees: Grantee[]) => Promise<void>;
  /** The server's one-click OAuth start: its consent URL, or null when it has none. */
  startSignIn: (projectId: string, connectionId: string, returnUrl: string) => Promise<string | null>;
}

/**
 * Add an MCP server from its URL in one step: the connector, then the account
 * for who may use it, then the server's sign-in. "Only you" makes no shared
 * account at all (`authorization_strategy: 'user'`), so a personal login never
 * lands in a project-wide account. "Specific people" narrows the shared
 * account before it holds a credential, as Add account does.
 */
export async function addMcpServer(
  projectId: string,
  input: {
    url: string;
    /** A catalogue app's own server: the connector is named after the app. */
    appName?: string;
    /** The slug to use, when the caller has one the API picked (never reserved or taken). */
    slug?: string;
    /** Sign in even when the server lists its tools without a credential
     *  (Google's do): the caller already knows the sign-in is one click. */
    signIn?: boolean;
    audience: 'private' | 'project' | 'members';
    /** Who "Specific people" picked. */
    grantees?: readonly Grantee[];
    takenSlugs: readonly string[];
    /** Where the provider's consent returns to. */
    returnUrl: (slug: string) => string;
  },
  deps: AddMcpServerDeps,
): Promise<{
  slug: string;
  name: string;
  /** The account just made: the one the sign-in (or credential entry) is for. */
  connectionId: string;
  /** The provider's consent page. Null when there is nothing to sign in, or it could not start. */
  signInUrl: string | null;
  /** Why the sign-in could not start, in the server's words. */
  signInError: string | null;
  syncError: string | null;
}> {
  const identity = input.appName
    ? input.slug
      ? { slug: input.slug, name: input.appName }
      : mcpAppIdentity(input.appName, input.takenSlugs)
    : mcpServerIdentity(input.url, input.takenSlugs);
  if (!identity) throw new Error('Enter the MCP server URL, starting with https://');
  const { slug, name } = identity;
  const created = await deps.createConnector(projectId, {
    slug,
    name,
    provider: 'mcp',
    url: input.url.trim(),
    transport: 'http',
    authorization_strategy: input.audience === 'private' ? 'user' : 'project',
    // A slug another connector already has answers 409; it never replaces that connector.
    create_only: true,
  });
  const account =
    input.audience === 'private'
      ? await deps.createMemberAccount(projectId, { connector_alias: slug, label: name })
      : await deps.projectAccount(projectId, slug, name);
  const connectionId = account.connection_id;
  if (input.audience === 'members') {
    await deps.grantAccess(projectId, connectionId, [...(input.grantees ?? [])]);
  }
  // `signInPending` reads the auth scheme from the 401's challenge header. A
  // server that sends no header can still publish its OAuth metadata at the
  // well-known URLs, which the sign-in discovery also tries.
  const challenged = created.syncError !== null && isAuthChallenge(created.syncError);
  if (!input.signIn && !created.signInPending && !challenged) {
    return { slug, name, connectionId, signInUrl: null, signInError: null, syncError: created.syncError };
  }
  // The connector and its account exist either way: a sign-in that cannot
  // start says why, and the connector page retries it.
  try {
    const signInUrl = await deps.startSignIn(projectId, connectionId, input.returnUrl(slug));
    // No one-click sign-in: the 401 stays, and the connector page asks for a credential.
    const syncError = signInUrl ? null : created.syncError;
    return { slug, name, connectionId, signInUrl, signInError: null, syncError };
  } catch (error) {
    const signInError = error instanceof Error ? error.message : String(error);
    return { slug, name, connectionId, signInUrl: null, signInError, syncError: null };
  }
}
