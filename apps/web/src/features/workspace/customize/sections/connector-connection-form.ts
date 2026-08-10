import type {
  WorkspaceAdminConnector,
  WorkspaceConnectorAuthorizationStrategy,
  WorkspaceConnectorDraftInput,
  ConnectorSyncResult,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

const MAX_CONNECTOR_SLUG_LENGTH = 128;

export interface EasyConnectApp {
  slug: string;
  name: string;
  /** Catalogue metadata, when the source publishes it (Pipedream apps do).
   *  Optional so a hand-typed `{ slug, name }` stays valid; the connection
   *  modal simply renders less without them. */
  description?: string | null;
  imgSrc?: string | null;
}

export interface EasyConnectConnectionInput {
  name: string;
  slug: string;
  authorizationStrategy: WorkspaceConnectorAuthorizationStrategy;
}

export type ConnectorSetupStatus =
  'connected' | 'error' | 'needs_setup' | 'no_auth' | 'user_managed';

export function connectorConnectionQueryKeys(workspaceId: string) {
  return [
    qk.workspace.connectors(workspaceId),
    ['connections', workspaceId],
    ['connections-all', workspaceId],
    ['session-scope-catalog', workspaceId],
  ] as const;
}

export function connectionOwnerTypeForStrategy(
  strategy: WorkspaceConnectorAuthorizationStrategy,
): 'workspace' | 'member' {
  return strategy === 'workspace' ? 'workspace' : 'member';
}

export function connectorAuthorizationStrategyForProvider(
  provider: WorkspaceConnectorDraftInput['provider'],
  strategy: WorkspaceConnectorAuthorizationStrategy,
): WorkspaceConnectorAuthorizationStrategy {
  return provider === 'channel' || provider === 'computer' ? 'workspace' : strategy;
}

export function connectorAuthorizationStrategyIsEditable(
  provider: WorkspaceConnectorDraftInput['provider'],
): boolean {
  return provider !== 'channel' && provider !== 'computer';
}

export function connectorAuthorizationUpdateIsPending(
  current: WorkspaceConnectorAuthorizationStrategy,
  submitted: WorkspaceConnectorAuthorizationStrategy | null,
  mutationPending: boolean,
): boolean {
  return mutationPending || (submitted !== null && submitted !== current);
}

export function createOnlyConnectorDraft(draft: WorkspaceConnectorDraftInput): WorkspaceConnectorDraftInput {
  return {
    ...draft,
    authorization_strategy: connectorAuthorizationStrategyForProvider(
      draft.provider,
      draft.authorization_strategy ?? 'workspace',
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
  connector: Pick<WorkspaceAdminConnector, 'authorizationStrategy' | 'authSecret' | 'secretSet' | 'status'>,
): ConnectorSetupStatus {
  if (connector.status === 'error') return 'error';
  if (!connector.authSecret) return 'no_auth';
  if (connector.authorizationStrategy === 'user') return 'user_managed';
  return connector.secretSet ? 'connected' : 'needs_setup';
}

export function normalizeConnectorConnectionSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/g, '')
    .slice(0, MAX_CONNECTOR_SLUG_LENGTH);
}

export function isConnectorConnectionSlugAvailable(
  slug: string,
  existingSlugs: readonly string[],
): boolean {
  const normalized = normalizeConnectorConnectionSlug(slug);
  return normalized.length > 0 && !existingSlugs.includes(normalized);
}

export function proposeConnectorConnectionSlug(
  displayName: string,
  existingSlugs: readonly string[],
): string {
  const base = normalizeConnectorConnectionSlug(displayName) || 'connector';
  if (isConnectorConnectionSlugAvailable(base, existingSlugs)) return base;

  for (let index = 1; ; index += 1) {
    const suffix = `-${index}`;
    const stem = base.slice(0, MAX_CONNECTOR_SLUG_LENGTH - suffix.length).replace(/[-_]+$/g, '');
    const candidate = `${stem}${suffix}`;
    if (isConnectorConnectionSlugAvailable(candidate, existingSlugs)) return candidate;
  }
}

export function connectorConnectionSlugAfterNameChange({
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
  return slugEdited ? currentSlug : proposeConnectorConnectionSlug(displayName, existingSlugs);
}

export function buildEmailConnectorConnectionSlug(baseInput: string, uniqueId: string): string {
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
      .slice(0, 12) || 'connection';
  return `email_${base}_${suffix}`;
}

export function buildEasyConnectConnectorDraft(
  app: EasyConnectApp,
  connection: EasyConnectConnectionInput,
): WorkspaceConnectorDraftInput {
  return createOnlyConnectorDraft({
    slug: connection.slug,
    name: connection.name.trim(),
    provider: 'pipedream',
    app: app.slug,
    account: 'default',
    authorization_strategy: connection.authorizationStrategy,
  });
}
