import type {
  AdminConnector,
  ConnectorAuthorizationStrategy,
  ConnectorDraftInput,
  ConnectorSyncResult,
} from '@kortix/sdk';

const MAX_CONNECTOR_PROFILE_SLUG_LENGTH = 128;

export interface EasyConnectApp {
  slug: string;
  name: string;
}

export interface EasyConnectProfileInput {
  name: string;
  slug: string;
  authorizationStrategy: ConnectorAuthorizationStrategy;
}

export type ConnectorSetupStatus =
  'connected' | 'error' | 'needs_setup' | 'no_auth' | 'user_managed';

export function connectorAuthorizationQueryKeys(projectId: string) {
  return [
    ['project-connectors', projectId],
    ['connector-profiles', projectId],
    ['connector-profiles-all', projectId],
    ['session-scope-catalog', projectId],
  ] as const;
}

export function authorizationOwnerTypeForStrategy(
  strategy: ConnectorAuthorizationStrategy,
): 'project' | 'member' {
  return strategy === 'project' ? 'project' : 'member';
}

export function connectorAuthorizationStrategyForProvider(
  provider: ConnectorDraftInput['provider'],
  strategy: ConnectorAuthorizationStrategy,
): ConnectorAuthorizationStrategy {
  return provider === 'channel' || provider === 'computer' ? 'project' : strategy;
}

export function connectorAuthorizationStrategyIsEditable(
  provider: ConnectorDraftInput['provider'],
): boolean {
  return provider !== 'channel' && provider !== 'computer';
}

export function connectorAuthorizationUpdateIsPending(
  current: ConnectorAuthorizationStrategy,
  submitted: ConnectorAuthorizationStrategy | null,
  mutationPending: boolean,
): boolean {
  return mutationPending || (submitted !== null && submitted !== current);
}

export function createOnlyConnectorDraft(draft: ConnectorDraftInput): ConnectorDraftInput {
  return {
    ...draft,
    authorization_strategy: connectorAuthorizationStrategyForProvider(
      draft.provider,
      draft.authorization_strategy ?? 'project',
    ),
    create_only: true,
  };
}

export function connectorSyncErrorForSlug(
  result: { sync?: ConnectorSyncResult },
  slug: string,
): string | null {
  return result.sync?.errors.find((error) => error.slug === slug)?.error ?? null;
}

export function connectorSetupStatus(
  connector: Pick<AdminConnector, 'authorizationStrategy' | 'authSecret' | 'secretSet' | 'status'>,
): ConnectorSetupStatus {
  if (connector.status === 'error') return 'error';
  if (!connector.authSecret) return 'no_auth';
  if (connector.authorizationStrategy === 'user') return 'user_managed';
  return connector.secretSet ? 'connected' : 'needs_setup';
}

export function normalizeConnectorProfileSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/g, '')
    .slice(0, MAX_CONNECTOR_PROFILE_SLUG_LENGTH);
}

export function isConnectorProfileSlugAvailable(
  slug: string,
  existingSlugs: readonly string[],
): boolean {
  const normalized = normalizeConnectorProfileSlug(slug);
  return normalized.length > 0 && !existingSlugs.includes(normalized);
}

export function proposeConnectorProfileSlug(
  displayName: string,
  existingSlugs: readonly string[],
): string {
  const base = normalizeConnectorProfileSlug(displayName) || 'connector';
  if (isConnectorProfileSlugAvailable(base, existingSlugs)) return base;

  for (let index = 1; ; index += 1) {
    const suffix = `-${index}`;
    const stem = base
      .slice(0, MAX_CONNECTOR_PROFILE_SLUG_LENGTH - suffix.length)
      .replace(/[-_]+$/g, '');
    const candidate = `${stem}${suffix}`;
    if (isConnectorProfileSlugAvailable(candidate, existingSlugs)) return candidate;
  }
}

export function proposeComposioConnectorSlug(
  toolkitSlug: string,
  existingSlugs: readonly string[],
): string {
  return proposeConnectorProfileSlug(`composio-${toolkitSlug}`, existingSlugs);
}

export function connectorProfileSlugAfterNameChange({
  displayName,
  currentSlug,
  existingSlugs,
  slugEdited,
}: {
  displayName: string;
  currentSlug: string;
  existingSlugs: readonly string[];
  slugEdited: boolean;
}): string {
  return slugEdited ? currentSlug : proposeConnectorProfileSlug(displayName, existingSlugs);
}

export function buildEmailConnectorProfileSlug(baseInput: string, uniqueId: string): string {
  const base =
    baseInput
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'inbox';
  const suffix =
    uniqueId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12) || 'profile';
  return `email_${base}_${suffix}`;
}

export function buildEasyConnectProfileDraft(
  app: EasyConnectApp,
  profile: EasyConnectProfileInput,
): ConnectorDraftInput {
  return createOnlyConnectorDraft({
    slug: profile.slug,
    name: profile.name.trim(),
    provider: 'pipedream',
    app: app.slug,
    account: 'default',
    authorization_strategy: profile.authorizationStrategy,
  });
}
