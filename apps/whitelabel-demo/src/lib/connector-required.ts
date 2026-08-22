import { serverErrorBody } from './api-error-body';

/**
 * The platform's PRE-FLIGHT refusal: the session declares a connector that has
 * no usable connection, so create is refused before a sandbox boots, before a
 * token is spent, and before the agent can improvise an apology at the first
 * tool call. That refusal is the one moment where the truth is cheap — the
 * platform already knows the answer — so it has to reach the screen intact.
 *
 * Two codes carry it and they are NOT interchangeable:
 *
 * - `CONNECTOR_CONNECTION_REQUIRED` (409) — the connector exists on the
 *   project and nothing is connected to it that this caller may use. The body
 *   carries `connector_connections`, each with an `authorization_strategy`, and
 *   that strategy is the whole answer to "who can fix this":
 *     • `project` — one shared connection serves the project. Anyone who can
 *       mint a setup link can connect it once, for everyone.
 *     • `user` — the connection must belong to the ACCOUNT THE SESSION RUNS AS.
 *       A wrapper runs every end-user's session under one operator credential,
 *       so no end-user can ever satisfy this themselves.
 * - `REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE` (409) — the alias is not a
 *   connector on this project at all. Nobody can connect their way out of that;
 *   it takes a manifest change.
 *
 * `CONNECTOR_AUTHORIZATION_REQUIRED` — which this app used to classify, and which
 * the public guide documented — has never existed in the API. It matched
 * nothing, so the connect prompt behind it was unreachable and every one of
 * these refusals fell through to a generic "could not start a session" toast.
 * Unknown codes are ignored here rather than guessed at, so a future rename
 * degrades to the generic path instead of showing confident nonsense.
 */

export type ConnectorAuthorizationStrategy = 'project' | 'user';

export type ConnectorRemedy =
  /** `project` strategy — one shared connection unblocks everyone. */
  | 'shared_connection'
  /** `user` strategy — only the session's own account can connect it. */
  | 'own_account'
  /** The alias is not a connector on this project. */
  | 'not_configured'
  /** The refusal named the connector but not how it authorizes. */
  | 'unknown';

export interface RequiredConnector {
  /** The project alias/slug — what `require_connectors` and the manifest name. */
  alias: string;
  /** Display name from the manifest; falls back to the alias. */
  name: string;
  strategy: ConnectorAuthorizationStrategy | null;
  remedy: ConnectorRemedy;
}

export interface ConnectorRequirement {
  code: 'CONNECTOR_CONNECTION_REQUIRED' | 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE';
  /** Empty only when the server named no connector — the UI still explains. */
  connectors: RequiredConnector[];
  /** The server's own sentence. Never shown alone: it names no remedy. */
  message: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function strategyOf(value: unknown): ConnectorAuthorizationStrategy | null {
  return value === 'project' || value === 'user' ? value : null;
}

function remedyOf(strategy: ConnectorAuthorizationStrategy | null): ConnectorRemedy {
  if (strategy === 'project') return 'shared_connection';
  if (strategy === 'user') return 'own_account';
  return 'unknown';
}

/**
 * The alias, when the refusal only carries prose.
 *
 * `REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE` sends
 * `Required connector "gmail" is unavailable` with no structured alias
 * field, and naming the connector is the difference between a call to action
 * and "something is missing". A structured field is preferred whenever the API
 * grows one; the quoted-token read is the fallback, and failing it leaves the
 * list empty rather than inventing a name.
 */
function quotedAlias(message: string | null): string | null {
  return text(message?.match(/"([^"]+)"/)?.[1]);
}

export function connectorRequirement(err: unknown): ConnectorRequirement | null {
  const body = serverErrorBody(err);
  if (!body) return null;
  const code = text(body.code);
  const raw = body.raw ?? {};
  // The API sends `message` on the authorization refusal and `error` on the
  // unavailable one; `serverErrorBody` already falls back to the SDK's coerced
  // `ApiError.message`, which is derived from whichever of the two was present.
  const message = text(raw.message) ?? text(body.error) ?? '';

  if (code === 'CONNECTOR_CONNECTION_REQUIRED') {
    // Snake case is the wire shape; the camel alias is accepted so a client
    // that has already normalised the body classifies identically.
    const listed = [raw.connector_connections, raw.connectorConnections].find(Array.isArray) as
      | unknown[]
      | undefined;
    const connectors: RequiredConnector[] = [];
    for (const entry of listed ?? []) {
      if (!entry || typeof entry !== 'object') continue;
      const connection = entry as Record<string, unknown>;
      const alias = text(connection.slug) ?? text(connection.alias);
      if (!alias) continue;
      const strategy = strategyOf(connection.authorization_strategy ?? connection.authorizationStrategy);
      connectors.push({
        alias,
        name: text(connection.name) ?? alias,
        strategy,
        remedy: remedyOf(strategy),
      });
    }
    return { code, connectors, message };
  }

  if (code === 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE') {
    // `connectors` first: it is the machine-readable list, and the guide tells
    // connectors to read it rather than parse the sentence. The prose reads
    // stay behind it for a server that predates the field — and because the
    // create path and the prompt path reach this code from different throw
    // sites, only one of which used to carry the array.
    const listed = Array.isArray(raw.connectors)
      ? raw.connectors.map(text).filter((entry): entry is string => entry !== null)
      : [];
    const aliases = listed.length
      ? listed
      : [text(raw.alias) ?? text(body.connector) ?? quotedAlias(message)].filter(
          (entry): entry is string => entry !== null,
        );
    return {
      code,
      connectors: aliases.map((alias) => ({
        alias,
        name: alias,
        strategy: null,
        remedy: 'not_configured' as const,
      })),
      message,
    };
  }

  return null;
}

export interface ConnectorRemedyCopy {
  headline: string;
  /** Why this session cannot start, in the end-user's terms. */
  explanation: string;
  /** What would actually unblock it. Listed, never implied by a dead button. */
  unblockedBy: string[];
  /**
   * Whether this app can mint a connect link for this connector itself.
   *
   * True ONLY for the `project` strategy: `POST /projects/{id}/connect-requests`
   * is reachable through the wrapper proxy (it is a `projects/{id}/…` route)
   * and refuses any other strategy outright with
   * `CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH`. Offering the button anywhere
   * else would be offering a 409.
   */
  canMintConnectLink: boolean;
}

/**
 * @param options.wrapperMode Whether this app is talking to Kortix under ONE
 *   operator credential (`GET /api/mode`). It changes who "the account the
 *   session runs as" is for a `user`-strategy connector — the operator in
 *   wrapper mode, the person holding the API key in direct mode — and so who
 *   can fix it. `null` means the caller does not know (a toast classifier has
 *   no hook), and produces copy that is true either way rather than a guess.
 */
export function connectorRemedy(
  connector: RequiredConnector,
  options: { wrapperMode: boolean | null },
): ConnectorRemedyCopy {
  const { alias, name, remedy } = connector;

  if (remedy === 'not_configured') {
    return {
      headline: `${name} is not set up on this project`,
      explanation: `This session declares ${alias}, but the project has no ${alias} connector for an account to be connected to. Connecting something will not change that.`,
      unblockedBy: [
        `Whoever maintains this project adds "${alias}" to its agent manifest and redeploys.`,
      ],
      canMintConnectLink: false,
    };
  }

  if (remedy === 'shared_connection') {
    return {
      headline: `Connect ${name} to start this session`,
      explanation: `This session needs ${name} and cannot start without it. ${name} is shared across the project — one connected account serves everyone here, so connecting it once unblocks this session and every other one that needs it.`,
      unblockedBy: [
        `Open a connect link and sign in to ${name} once.`,
        `Or ask a teammate who already uses ${name} here to connect it.`,
      ],
      canMintConnectLink: true,
    };
  }

  if (remedy === 'own_account') {
    if (options.wrapperMode === true) {
      return {
        headline: `${name} has to be connected before this session can start`,
        explanation: `This session needs ${name} and cannot start without it. ${name} authorizes one person at a time, and sessions here run under this app's own Kortix credential rather than yours — so there is nothing it can connect on your behalf, and a link would only ever reconnect that same account.`,
        unblockedBy: [
          `The operator of this app connects ${name} for the account it runs sessions as.`,
          `Or the project switches ${alias} to a shared (project) authorization, which anyone can then connect once with a link.`,
        ],
        canMintConnectLink: false,
      };
    }
    if (options.wrapperMode === false) {
      return {
        headline: `Connect ${name} in your Kortix account`,
        explanation: `This session needs ${name} and cannot start without it. ${name} authorizes one person at a time, so it has to be connected by the account this app is signed in with — a connection that lives in Kortix, and that this app has no screen for making.`,
        unblockedBy: [`Connect ${alias} from your Kortix dashboard, then retry.`],
        canMintConnectLink: false,
      };
    }
    return {
      headline: `${name} has to be connected before this session can start`,
      explanation: `This session needs ${name} and cannot start without it. ${name} authorizes one person at a time, so it has to be connected by the account this app runs sessions as — which is not something the session can do for itself.`,
      unblockedBy: [
        `${name} is connected for the account this app runs sessions as.`,
        `Or the project switches ${alias} to a shared (project) authorization, which anyone can then connect once with a link.`,
      ],
      canMintConnectLink: false,
    };
  }

  return {
    headline: `Connect ${name} to start this session`,
    explanation: `This session needs ${name} and cannot start without it. The refusal did not say how ${alias} authorizes, so whether a shared connection or a personal one is required cannot be told from here.`,
    unblockedBy: [
      `Check ${alias} in the project's connectors: a shared one can be connected once for everyone, a personal one has to be connected by the account the session runs as.`,
    ],
    canMintConnectLink: false,
  };
}

/**
 * The one-line version, for surfaces that only have a toast.
 *
 * Shares its wording with the card so a user who sees both is not told two
 * different stories about the same refusal. Mode is unknown here — a toast
 * classifier is a pure function with no hook — so the `user`-strategy copy
 * lands on the sentence that is true in either mode.
 */
export function connectorRequirementSummary(requirement: ConnectorRequirement): {
  title: string;
  detail: string;
} {
  const [first, ...rest] = requirement.connectors;
  if (!first) {
    return {
      title: 'This session needs a connector that is not connected',
      detail:
        requirement.message ||
        'The session declares a connector with no usable connection, so it cannot start.',
    };
  }
  if (rest.length > 0) {
    const names = requirement.connectors.map((c) => c.name).join(', ');
    return {
      title: `This session needs ${requirement.connectors.length} connectors that are not connected`,
      detail: `${names} — none of them has a connection this session can use, so it cannot start.`,
    };
  }
  const copy = connectorRemedy(first, { wrapperMode: null });
  return { title: copy.headline, detail: copy.explanation };
}
