import type {
  AdminConnector,
  Connection,
  WorkspaceSecret,
  SessionScope,
  SessionScopeInput,
} from '@kortix/sdk';

export interface SessionScopeDraft {
  secrets?: string[] | null;
  connector_bindings?: Record<string, { connection_id: string }>;
  /**
   * The connector bindings are a preview of server-resolved defaults, not a
   * caller replacement. New sessions keep this marker until the user changes
   * connector scope. Omitting the replacement lets the server discard stale or
   * disconnected rows while preserving an explicit user deselection.
   */
  connector_bindings_inherited?: boolean;
  /**
   * Connectors this session REQUIRES but has no connection for yet.
   *
   * A binding is "use THIS connection", so a connector with nothing connected
   * had nowhere to be recorded and the checkbox was simply greyed out — you
   * could not say "this session needs Gmail" until Gmail already worked. Naming
   * it here makes the next turn stop at a connect prompt instead of letting the
   * agent find out mid-answer.
   *
   * Only ever holds aliases with no binding: once one is chosen the binding
   * carries the requirement, and the two must not disagree about the same alias.
   */
  require_connectors?: string[];
}

export type SessionScopeGrant = 'all' | 'none' | readonly string[] | null | undefined;

export type SessionScopeCatalogState<T> =
  { status: 'ready'; items: readonly T[] } | { status: 'unavailable' };

export interface SessionScopeCatalogGrants {
  secrets?: SessionScopeGrant;
  connectors?: SessionScopeGrant;
}

export interface SessionScopeRawCatalogs {
  secrets: SessionScopeCatalogState<WorkspaceSecret>;
  connectors: SessionScopeCatalogState<AdminConnector>;
  connections: SessionScopeCatalogState<Connection>;
  grants?: SessionScopeCatalogGrants;
}

export interface SessionScopeSecretOption {
  identifier: string;
  name: string;
}

export interface SessionScopeConnectionOption {
  connection_id: string;
  label: string;
  is_default: boolean;
}

export interface SessionScopeConnectorOption {
  slug: string;
  name: string;
  authorization_strategy: AdminConnector['authorizationStrategy'];
  connections: SessionScopeConnectionOption[];
}

export interface SessionScopeSelectionCatalog {
  secrets: SessionScopeCatalogState<SessionScopeSecretOption>;
  connector_connections: SessionScopeCatalogState<SessionScopeConnectorOption>;
}

export interface SessionScopeAvailability {
  secrets: boolean;
  connector_bindings: boolean;
}

export interface SessionScopeCommit {
  draft: SessionScopeDraft;
  availability: SessionScopeAvailability;
}

function cloneBindings(
  bindings: Record<string, { connection_id: string }>,
): Record<string, { connection_id: string }> {
  return Object.fromEntries(
    Object.entries(bindings).map(([alias, binding]) => [
      alias,
      {
        connection_id: binding.connection_id,
      },
    ]),
  );
}

/**
 * Connector grant membership. Exact match, on purpose: the server compares
 * canonical slugs with a plain `includes` (`agentMayUseConnector`), so a looser
 * match here would offer a connector the call gate then rejects.
 */
function connectorGrantIncludes(grant: SessionScopeGrant, slug: string): boolean {
  if (grant === 'none') return false;
  if (grant === 'all' || grant == null) return true;
  return grant.includes(slug);
}

/**
 * Secret grant membership. Case-INSENSITIVE, matching the server
 * (`agentMayUseEnv`, and `listAdmits` in the delivery rule). The grant is the
 * hand-written `secrets:` list from kortix.yaml, so its case need not match the
 * stored identifier. An exact match here hid secrets the server does deliver.
 */
function secretGrantIncludes(grant: SessionScopeGrant, identifier: string): boolean {
  if (grant === 'none') return false;
  if (grant === 'all' || grant == null) return true;
  const target = identifier.toUpperCase();
  return grant.some((entry) => entry.toUpperCase() === target);
}

export function createSessionScopeDraft(
  scope: SessionScope,
  catalog?: SessionScopeSelectionCatalog,
): SessionScopeDraft {
  const draft: SessionScopeDraft = {};
  if (!catalog || catalog.secrets.status === 'ready') {
    draft.secrets = scope.secrets_allowlist === null ? null : [...scope.secrets_allowlist];
  }
  if (!catalog || catalog.connector_connections.status === 'ready') {
    draft.connector_bindings = cloneBindings(scope.connector_bindings);
    // `scope.connector_bindings` is the SERVER-RESOLVED map, which is identical
    // for a session that overrode its connectors and one that just inherits the
    // workspace defaults. `connector_bindings_configured` is the only thing that
    // separates them. Without this marker the draft treated the preview as a
    // user selection, so an untouched Save posted it back as a full
    // replacement — freezing workspace defaults into an override, and turning an
    // empty resolve into an explicit zero-connector session.
    draft.connector_bindings_inherited = scope.connector_bindings_configured !== true;
    draft.require_connectors = [...(scope.required_connectors ?? [])];
  }
  return draft;
}

/**
 * The connections a session inherits today: each granted connector's default
 * (or only) connection. A PREVIEW of what the server resolves, never a
 * selection — it is always paired with `connector_bindings_inherited`.
 */
function defaultConnectorBindingsPreview(
  catalog: SessionScopeSelectionCatalog,
): Record<string, { connection_id: string }> {
  if (catalog.connector_connections.status !== 'ready') return {};
  return Object.fromEntries(
    catalog.connector_connections.items.flatMap((connector) => {
      const connection =
        connector.connections.find((candidate) => candidate.is_default) ?? connector.connections[0];
      return connection ? [[connector.slug, { connection_id: connection.connection_id }]] : [];
    }),
  );
}

/**
 * Drop a session's secret override. `null` is "inherit the agent's grant" —
 * the state a session starts in — and is the opposite of `[]`.
 */
export function resetSessionSecrets(draft: SessionScopeDraft): SessionScopeDraft {
  return { ...draft, secrets: null };
}

/**
 * Drop a session's connector override and preview the workspace defaults again.
 *
 * The marker is what makes `buildSessionScopeReplacement` send
 * `connector_bindings: null` — the API's clear verb — when the session actually
 * holds an override. An override the user cannot switch off is a trap.
 */
export function resetSessionConnectorBindings(
  draft: SessionScopeDraft,
  catalog: SessionScopeSelectionCatalog,
): SessionScopeDraft {
  return {
    ...draft,
    connector_bindings: defaultConnectorBindingsPreview(catalog),
    connector_bindings_inherited: true,
    // A requirement is an override too: it stops the next turn until the alias
    // is connected. Resetting the axis clears it with the bindings.
    require_connectors: [],
  };
}

/**
 * How an inherited axis reads in the UI — named for where the default really
 * comes from, per axis. Secrets: `intersectSecretGrants(grant, null)` returns
 * the AGENT's grant untouched, so the inherited state is the agent's. Connectors:
 * the agent's grant gates the set, but each granted alias resolves to the
 * WORKSPACE's default connection (`resolveWorkspaceDefaultConnectorConnection`).
 */
export const SESSION_SCOPE_SECRETS_INHERITED_LABEL = 'Agent default';
export const SESSION_SCOPE_CONNECTORS_INHERITED_LABEL = 'Workspace default';

export function sessionSecretsSummary(draft: SessionScopeDraft): string {
  if (draft.secrets === undefined) return 'Unchanged';
  // `null` = inherit whatever the agent's grant allows. Calling this "All
  // allowed" overstated it, and calling it "None selected" inverted it.
  if (draft.secrets === null) return SESSION_SCOPE_SECRETS_INHERITED_LABEL;
  if (draft.secrets.length === 0) return 'None allowed';
  return `${draft.secrets.length} selected`;
}

export function sessionConnectorsSummary(draft: SessionScopeDraft): string {
  if (draft.connector_bindings === undefined) return 'Unchanged';
  if (draft.connector_bindings_inherited === true) return SESSION_SCOPE_CONNECTORS_INHERITED_LABEL;
  const bound = Object.keys(draft.connector_bindings);
  // A required-but-unconnected alias is selected too — it has no connection to
  // bind, which is precisely why it is recorded separately.
  const required = (draft.require_connectors ?? []).filter((alias) => !bound.includes(alias));
  const count = bound.length + required.length;
  return count === 0 ? 'None allowed' : `${count} selected`;
}

/** True when this axis holds an explicit override rather than inheriting. */
export function sessionSecretsAreOverridden(draft: SessionScopeDraft): boolean {
  return draft.secrets !== undefined && draft.secrets !== null;
}

export function sessionConnectorsAreOverridden(draft: SessionScopeDraft): boolean {
  return draft.connector_bindings !== undefined && draft.connector_bindings_inherited !== true;
}

export function createNewSessionScopeDraft(
  catalog: SessionScopeSelectionCatalog,
): SessionScopeDraft {
  const draft: SessionScopeDraft = {};
  if (catalog.secrets.status === 'ready') {
    // No user override yet. `null` means "inherit everything the agent's grant
    // allows" — the same state a server-created session starts in. `[]` would be
    // an EXPLICIT "inject zero workspace secrets", which silently denied every
    // browser-created session its grant on the first prompt. The user can still
    // deliberately deselect all (see `setAllSessionSecrets`) to get `[]`; the
    // two are opposite and must not be conflated.
    draft.secrets = null;
  }
  if (catalog.connector_connections.status === 'ready') {
    // Preview every strategy-compatible default that the agent grant exposes.
    // The inherited marker keeps an untouched session on server-side resolution,
    // which filters stale or disconnected rows. A user change clears the marker
    // and turns the draft into a complete fail-closed replacement.
    draft.connector_bindings = defaultConnectorBindingsPreview(catalog);
    draft.connector_bindings_inherited = true;
    draft.require_connectors = [];
  }
  return draft;
}

export function buildSessionScopeReplacement(
  draft: SessionScopeDraft,
  previousScope?: SessionScope,
  availability: SessionScopeAvailability = {
    secrets: true,
    connector_bindings: true,
  },
): SessionScopeInput {
  const replacement: SessionScopeInput = {};
  const secrets = Object.hasOwn(draft, 'secrets')
    ? draft.secrets
    : previousScope?.secrets_allowlist;
  if (availability.secrets && secrets !== undefined) {
    replacement.secrets = secrets === null ? null : [...secrets];
  }
  const connectorBindings = Object.hasOwn(draft, 'connector_bindings')
    ? draft.connector_bindings
    : previousScope?.connector_bindings;
  if (availability.connector_bindings) {
    if (draft.connector_bindings_inherited === true) {
      // Inheriting. Send the API's clear verb ONLY when the session actually
      // holds an override — that is the one case with something to undo. With
      // nothing to undo the key stays out entirely, so an untouched Save cannot
      // create the override it is trying to avoid.
      if (previousScope?.connector_bindings_configured === true) {
        replacement.connector_bindings = null;
      }
    } else if (connectorBindings !== undefined) {
      replacement.connector_bindings = cloneBindings(connectorBindings);
    }
  }
  const required = Object.hasOwn(draft, 'require_connectors')
    ? draft.require_connectors
    : previousScope?.required_connectors;
  if (availability.connector_bindings && required !== undefined) {
    // An alias that ended up with a binding is already required by that binding.
    // Sending it in both would have the server hold the same requirement twice
    // and, worse, keep requiring it after the binding is later removed.
    const bound = new Set(Object.keys(connectorBindings ?? {}));
    replacement.require_connectors = (required ?? []).filter((alias) => !bound.has(alias));
  }
  return replacement;
}

export function buildSessionScopeSelectionCatalog(
  input: SessionScopeRawCatalogs,
): SessionScopeSelectionCatalog {
  const secrets: SessionScopeSelectionCatalog['secrets'] =
    input.secrets.status === 'unavailable'
      ? { status: 'unavailable' }
      : {
          status: 'ready',
          items: input.secrets.items
            .filter(
              (secret) =>
                secret.effective_source !== 'none' &&
                secretGrantIncludes(input.grants?.secrets, secret.identifier),
            )
            .map((secret) => ({
              identifier: secret.identifier,
              name: secret.name,
            })),
        };

  if (input.connectors.status === 'unavailable' || input.connections.status === 'unavailable') {
    return {
      secrets,
      connector_connections: { status: 'unavailable' },
    };
  }
  const connectors = input.connectors.items;
  const connections = input.connections.items;

  return {
    secrets,
    connector_connections: {
      status: 'ready',
      items: connectors
        .filter(
          (connector) =>
            connector.status !== 'disabled' &&
            connectorGrantIncludes(input.grants?.connectors, connector.slug),
        )
        .map((connector) => {
          const ownerType = connector.authorizationStrategy === 'user' ? 'member' : 'workspace';
          return {
            slug: connector.slug,
            name: connector.name,
            authorization_strategy: connector.authorizationStrategy,
            connections: connections
              .filter(
                (connection) =>
                  connection.connector_alias === connector.slug &&
                  connection.owner_type === ownerType &&
                  connection.status === 'active',
              )
              .sort(
                (left, right) =>
                  Number(right.is_default) - Number(left.is_default) ||
                  left.connection_id.localeCompare(right.connection_id),
              )
              .map((connection) => ({
                connection_id: connection.connection_id,
                label: connection.label,
                is_default: connection.is_default,
              })),
          };
        }),
    },
  };
}
