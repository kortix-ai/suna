/**
 * One-click OAuth for a direct connector whose server publishes its own
 * authorization metadata (the MCP authorization chain, RFC 9728 + RFC 8414 +
 * RFC 7591): discover the authorization server, register Kortix as a client,
 * then start a device authorization (a code to enter, no page to return to)
 * when the server has one, else the Authorization Code + PKCE redirect.
 *
 * `oauth2AutoConnectPlan` and `buildOAuth2ClientRegistrationInput` are the pure
 * decisions; `startConnectionOAuth2SignIn` and `waitForConnectionOAuth2` run
 * them against the API. The web's connector pages and the TUI's `/connectors`
 * screen use the same ones.
 */

import {
  type OAuth2ClientRegistrationInput,
  type OAuth2ConnectionStatus,
  type OAuth2ResourceDiscovery,
  discoverConnectionOAuth2Resource,
  getConnectionOAuth2Status,
  pollConnectionOAuth2DeviceAuthorization,
  registerConnectionOAuth2Client,
  startConnectionOAuth2Authorization,
  startConnectionOAuth2DeviceAuthorization,
} from '../rest/projects-client/connectors';
import {
  CONNECT_LINK_POLL_INTERVAL_MS,
  CONNECT_LINK_TIMEOUT_MS,
  connectLinkTimeoutMessage,
  raceAbort,
} from './connect-link';

export type OAuth2AutoConnectPlan =
  /** Discovery has not run yet. */
  | { kind: 'unknown' }
  /** The server answered without credentials: it needs no OAuth connection. */
  | { kind: 'no_authorization' }
  /** Everything is discoverable: register dynamically (or take Kortix's own
   *  client, `kortix_client`), then authorize. */
  | {
      kind: 'register';
      label: string;
      /** Absent when Kortix signs in with its own OAuth client. */
      registrationEndpoint?: string;
      scopes: string[];
    }
  /** Endpoints are known but the server has no dynamic registration. */
  | { kind: 'client_id_required'; label: string; scopes: string[] }
  /** Nothing usable was discovered: the fields must be filled in by hand. */
  | { kind: 'manual'; reason: string };

function resourceLabel(discovery: OAuth2ResourceDiscovery): string {
  if (discovery.resource_name) return `Connect ${discovery.resource_name}`;
  try {
    return `Connect ${new URL(discovery.resource ?? discovery.resource_url).host}`;
  } catch {
    return 'Connect';
  }
}

export function oauth2AutoConnectPlan(
  discovery: OAuth2ResourceDiscovery | null | undefined,
): OAuth2AutoConnectPlan {
  if (!discovery) return { kind: 'unknown' };
  if (!discovery.requires_authorization) return { kind: 'no_authorization' };
  if (!discovery.metadata?.token_url && !discovery.metadata?.authorization_url) {
    return {
      kind: 'manual',
      reason:
        discovery.warnings.at(-1) ??
        'This server does not publish OAuth 2.0 metadata. Enter its endpoints manually.',
    };
  }
  const label = resourceLabel(discovery);
  if (discovery.kortix_client) return { kind: 'register', label, scopes: discovery.scopes };
  if (!discovery.registration_endpoint) {
    return { kind: 'client_id_required', label, scopes: discovery.scopes };
  }
  return {
    kind: 'register',
    label,
    registrationEndpoint: discovery.registration_endpoint,
    scopes: discovery.scopes,
  };
}

export function buildOAuth2ClientRegistrationInput(
  discovery: OAuth2ResourceDiscovery,
): OAuth2ClientRegistrationInput {
  if (!discovery.registration_endpoint && !discovery.kortix_client) {
    throw new Error('This authorization server does not support dynamic client registration');
  }
  const metadata = discovery.metadata ?? {};
  return {
    // Without it the API signs in with Kortix's own client for this server.
    ...(discovery.registration_endpoint
      ? { registration_endpoint: discovery.registration_endpoint }
      : {}),
    // Bind the issued client to the server that issued it, so the callback can
    // validate RFC 9207 `iss`.
    ...(discovery.authorization_server ? { issuer: discovery.authorization_server } : {}),
    ...(metadata.discovery_url ? { discovery_url: metadata.discovery_url } : {}),
    ...(metadata.authorization_url ? { authorization_url: metadata.authorization_url } : {}),
    ...(metadata.token_url ? { token_url: metadata.token_url } : {}),
    ...(metadata.device_authorization_url
      ? { device_authorization_url: metadata.device_authorization_url }
      : {}),
    ...(metadata.revocation_url ? { revocation_url: metadata.revocation_url } : {}),
    ...(discovery.token_endpoint_auth_methods_supported?.length
      ? {
          token_endpoint_auth_methods_supported: discovery.token_endpoint_auth_methods_supported,
        }
      : {}),
    ...(discovery.scopes.length ? { scopes: discovery.scopes } : {}),
    ...(discovery.resource ? { resource: discovery.resource } : {}),
  };
}

/** The REST calls behind a sign-in. Injectable for tests. */
export interface ConnectionOAuth2SignInDeps {
  discover: typeof discoverConnectionOAuth2Resource;
  register: typeof registerConnectionOAuth2Client;
  authorize: typeof startConnectionOAuth2Authorization;
  device: typeof startConnectionOAuth2DeviceAuthorization;
  pollDevice: (projectId: string, connectionId: string, sessionId: string) => Promise<OAuth2ConnectionStatus>;
  status: (projectId: string, connectionId: string) => Promise<OAuth2ConnectionStatus>;
}

const REST_DEPS: ConnectionOAuth2SignInDeps = {
  discover: discoverConnectionOAuth2Resource,
  register: registerConnectionOAuth2Client,
  authorize: startConnectionOAuth2Authorization,
  device: startConnectionOAuth2DeviceAuthorization,
  pollDevice: pollConnectionOAuth2DeviceAuthorization,
  status: getConnectionOAuth2Status,
};

export type ConnectionOAuth2SignInStart =
  /** Enter `userCode` at `url`. */
  | {
      kind: 'device';
      sessionId: string;
      userCode: string;
      url: string;
      expiresAt: string;
      intervalSeconds: number;
    }
  /** Open `url` and approve. The provider returns to `returnUrl`. */
  | { kind: 'browser'; url: string; expiresAt: string }
  /** The server needs no sign-in: the account works as made. */
  | { kind: 'none' }
  /** No one-click sign-in: the account needs a credential entered by hand. */
  | { kind: 'unavailable'; reason: string };

/**
 * Start a one-click sign-in for one direct connector account. A device code
 * when the server publishes a device endpoint (and the host prefers one), else
 * the authorization URL. `unavailable` when the server has no dynamic
 * registration: the caller asks for a credential instead.
 */
export async function startConnectionOAuth2SignIn(
  projectId: string,
  connectionId: string,
  options: {
    /** Where the provider sends the browser after a redirect sign-in. */
    returnUrl?: string;
    /** Try the device flow first. Default `true`. */
    preferDevice?: boolean;
    deps?: ConnectionOAuth2SignInDeps;
  } = {},
): Promise<ConnectionOAuth2SignInStart> {
  const deps = options.deps ?? REST_DEPS;
  const { discovery } = await deps.discover(projectId, connectionId);
  const plan = oauth2AutoConnectPlan(discovery);
  if (plan.kind === 'no_authorization') return { kind: 'none' };
  if (plan.kind !== 'register') {
    return {
      kind: 'unavailable',
      reason:
        plan.kind === 'manual'
          ? plan.reason
          : 'This server has no one-click sign-in. Enter a credential instead.',
    };
  }
  await deps.register(projectId, connectionId, buildOAuth2ClientRegistrationInput(discovery));
  const scopes = discovery.scopes.length ? { scopes: discovery.scopes } : {};
  if (options.preferDevice !== false && discovery.metadata?.device_authorization_url) {
    try {
      const device = await deps.device(projectId, connectionId, scopes);
      return {
        kind: 'device',
        sessionId: device.session_id,
        userCode: device.user_code,
        url: device.verification_uri_complete ?? device.verification_uri,
        expiresAt: device.expires_at,
        intervalSeconds: device.interval_seconds,
      };
    } catch {
      // A server that lists a device endpoint can still refuse this client:
      // the redirect flow is the one every server supports.
    }
  }
  const started = await deps.authorize(projectId, connectionId, {
    ...scopes,
    ...(options.returnUrl
      ? { success_redirect_uri: options.returnUrl, error_redirect_uri: options.returnUrl }
      : {}),
  });
  return { kind: 'browser', url: started.authorization_url, expiresAt: started.expires_at };
}

/**
 * Wait until a started sign-in holds a token: poll the device session at the
 * server's interval, or the connection's OAuth status every 2 s, up to 10
 * minutes. Rejects on an `error` or `revoked` status, the timeout, or abort.
 */
export async function waitForConnectionOAuth2(
  projectId: string,
  connectionId: string,
  start: Extract<ConnectionOAuth2SignInStart, { kind: 'device' | 'browser' }>,
  options: {
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
    deps?: ConnectionOAuth2SignInDeps;
  } = {},
): Promise<{ connected: true }> {
  const deps = options.deps ?? REST_DEPS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? CONNECT_LINK_TIMEOUT_MS;
  const interval =
    start.kind === 'device' ? Math.max(start.intervalSeconds, 1) * 1000 : CONNECT_LINK_POLL_INTERVAL_MS;
  const deadline = now() + timeoutMs;
  while (true) {
    const status = await raceAbort(
      start.kind === 'device'
        ? deps.pollDevice(projectId, connectionId, start.sessionId)
        : deps.status(projectId, connectionId),
      options.signal,
    );
    if (status.status === 'active') return { connected: true };
    // The device poll also answers `expired` (outside `OAuth2ConnectionStatus`).
    if ((status.status as string) === 'expired') throw new Error('The sign-in code expired. Start again.');
    if (status.status === 'error' || status.status === 'revoked') {
      throw new Error(`The sign-in failed: ${status.error_code ?? status.status}.`);
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error(connectLinkTimeoutMessage(timeoutMs));
    await raceAbort(sleep(Math.min(interval, remainingMs)), options.signal);
  }
}
