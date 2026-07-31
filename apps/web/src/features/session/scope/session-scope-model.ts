import type {
  AdminConnector,
  ConnectorAuthorization,
  ProjectSecret,
  SessionConnectorBindings,
  SessionScope,
  SessionScopeInput,
} from '@kortix/sdk';

export interface SessionScopeDraft {
  secrets?: string[] | null;
  connector_bindings?: SessionConnectorBindings;
  /**
   * Connectors this session REQUIRES but has no authorization for yet.
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
  secrets: SessionScopeCatalogState<ProjectSecret>;
  connectors: SessionScopeCatalogState<AdminConnector>;
  authorizations: SessionScopeCatalogState<ConnectorAuthorization>;
  grants?: SessionScopeCatalogGrants;
}

export interface SessionScopeSecretOption {
  identifier: string;
  name: string;
}

export interface SessionScopeAuthorizationOption {
  authorization_id: string;
  label: string;
  is_default: boolean;
}

export interface SessionScopeConnectorOption {
  slug: string;
  name: string;
  authorization_strategy: AdminConnector['authorizationStrategy'];
  authorizations: SessionScopeAuthorizationOption[];
}

export interface SessionScopeSelectionCatalog {
  secrets: SessionScopeCatalogState<SessionScopeSecretOption>;
  connector_profiles: SessionScopeCatalogState<SessionScopeConnectorOption>;
}

export interface SessionScopeAvailability {
  secrets: boolean;
  connector_bindings: boolean;
}

export interface SessionScopeCommit {
  draft: SessionScopeDraft;
  availability: SessionScopeAvailability;
}

function cloneBindings(bindings: SessionConnectorBindings): SessionConnectorBindings {
  return Object.fromEntries(
    Object.entries(bindings).map(([alias, binding]) => [
      alias,
      { authorization_id: binding.authorization_id },
    ]),
  );
}

function grantIncludes(grant: SessionScopeGrant, value: string): boolean {
  if (grant === 'none') return false;
  if (grant === 'all' || grant == null) return true;
  return grant.includes(value);
}

export function createSessionScopeDraft(
  scope: SessionScope,
  catalog?: SessionScopeSelectionCatalog,
): SessionScopeDraft {
  const draft: SessionScopeDraft = {};
  if (!catalog || catalog.secrets.status === 'ready') {
    draft.secrets = scope.secrets_allowlist === null ? null : [...scope.secrets_allowlist];
  }
  if (!catalog || catalog.connector_profiles.status === 'ready') {
    draft.connector_bindings = cloneBindings(scope.connector_bindings);
    draft.require_connectors = [...(scope.required_connectors ?? [])];
  }
  return draft;
}

export function createNewSessionScopeDraft(
  catalog: SessionScopeSelectionCatalog,
): SessionScopeDraft {
  const draft: SessionScopeDraft = {};
  if (catalog.secrets.status === 'ready') {
    draft.secrets = [];
  }
  if (catalog.connector_profiles.status === 'ready') {
    draft.connector_bindings = {};
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
  if (availability.connector_bindings && connectorBindings !== undefined) {
    replacement.connector_bindings = cloneBindings(connectorBindings);
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
                grantIncludes(input.grants?.secrets, secret.identifier),
            )
            .map((secret) => ({
              identifier: secret.identifier,
              name: secret.name,
            })),
        };

  if (input.connectors.status === 'unavailable' || input.authorizations.status === 'unavailable') {
    return {
      secrets,
      connector_profiles: { status: 'unavailable' },
    };
  }
  const connectors = input.connectors.items;
  const authorizations = input.authorizations.items;

  return {
    secrets,
    connector_profiles: {
      status: 'ready',
      items: connectors
        .filter(
          (connector) =>
            connector.status !== 'disabled' &&
            grantIncludes(input.grants?.connectors, connector.slug),
        )
        .map((connector) => {
          const ownerType = connector.authorizationStrategy === 'user' ? 'member' : 'project';
          return {
            slug: connector.slug,
            name: connector.name,
            authorization_strategy: connector.authorizationStrategy,
            authorizations: authorizations
              .filter(
                (authorization) =>
                  authorization.connector_alias === connector.slug &&
                  authorization.owner_type === ownerType &&
                  authorization.status === 'active',
              )
              .sort(
                (left, right) =>
                  Number(right.is_default) - Number(left.is_default) ||
                  left.profile_id.localeCompare(right.profile_id),
              )
              .map((authorization) => ({
                authorization_id: authorization.profile_id,
                label: authorization.label,
                is_default: authorization.is_default,
              })),
          };
        }),
    },
  };
}
