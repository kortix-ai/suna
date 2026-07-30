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
  }
  return draft;
}

export function createNewSessionScopeDraft(
  catalog: SessionScopeSelectionCatalog,
): SessionScopeDraft {
  const draft: SessionScopeDraft = {};
  if (catalog.secrets.status === 'ready') {
    draft.secrets = null;
  }
  if (catalog.connector_profiles.status === 'ready') {
    draft.connector_bindings = Object.fromEntries(
      catalog.connector_profiles.items.flatMap((connector) => {
        const authorization =
          connector.authorizations.find((candidate) => candidate.is_default) ??
          connector.authorizations[0];
        return authorization
          ? [[connector.slug, { authorization_id: authorization.authorization_id }]]
          : [];
      }),
    );
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
