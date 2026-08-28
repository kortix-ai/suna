import type {
  AdminConnector,
  ConnectorAuthorizationStrategy,
  ConnectorDraftInput,
  ConnectorSyncResult,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

const MAX_CONNECTOR_SLUG_LENGTH = 128;

export interface EasyConnectApp {
  slug: string;
  name: string;
  /** Hosted connector provider. Omitted only by legacy Pipedream callers. */
  provider?: 'composio' | 'pipedream';
  /** Catalogue metadata, when the source publishes it (Pipedream apps do).
   *  Optional so a hand-typed `{ slug, name }` stays valid; the connection
   *  modal simply renders less without them. */
  description?: string | null;
  imgSrc?: string | null;
}

export interface EasyConnectConnectionInput {
  name: string;
  slug: string;
  authorizationStrategy: ConnectorAuthorizationStrategy;
}

export type ConnectorSetupStatus =
  'connected' | 'error' | 'needs_setup' | 'no_auth' | 'user_managed';

export function connectorConnectionQueryKeys(projectId: string) {
  return [
    qk.project.connectors(projectId),
    ['connections', projectId],
    ['connections-all', projectId],
    ['session-scope-catalog', projectId],
  ] as const;
}

export function connectionOwnerTypeForStrategy(
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
  // An authorization that never completed is setup that never finished. This
  // used to fall through to the `authSecret`/`secretSet` branches, so an
  // unauthorized connector still rendered `connected` — a checkmark on the
  // connector grid (`connectors-page.tsx`), a green dot, and a place in the
  // "ready" partition, while the gateway refused every tool call against it
  // with `needs_auth`. Prod 2026-08-28: 6 of 6 GitHub connections had no
  // connected account and no GitHub tool call had ever run.
  if (connector.status === 'needs_auth') return 'needs_setup';
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
): ConnectorDraftInput {
  return createOnlyConnectorDraft({
    slug: connection.slug,
    name: connection.name.trim(),
    provider: app.provider ?? 'pipedream',
    app: app.slug,
    account: 'default',
    authorization_strategy: connection.authorizationStrategy,
  });
}
