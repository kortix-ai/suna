import {
  type AdminConnector,
  type ConnectorDraftInput,
  type ConnectorSyncResult,
  type DiscoverConnectorTemplate,
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
}

/** A connector's setup status. The rules live in `@kortix/sdk`. */
export {
  connectorSetupStatus,
  isConnectorAuthChallenge as isAuthChallenge,
  type ConnectorSetupStatus,
} from '@kortix/sdk';

export function connectorConnectionQueryKeys(projectId: string) {
  return [
    qk.project.connectors(projectId),
    ['connections', projectId],
    ['connections-all', projectId],
    ['session-scope-catalog', projectId],
  ] as const;
}

export function createOnlyConnectorDraft(draft: ConnectorDraftInput): ConnectorDraftInput {
  return { ...draft, create_only: true };
}

export function connectorSyncErrorForSlug(
  result: { sync?: ConnectorSyncResult },
  slug: string,
): string | null {
  return result.sync?.errors.find((error) => error.slug === slug)?.error ?? null;
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

/** Six base36 characters — 2.2 billion values; enough that a second
 *  connection to the same app never needs a human to invent a suffix. */
export function randomConnectorSlugSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/**
 * Always `<app>-<random>` (Marko, 2026-09-03: "unique slug, always
 * sentry-<something random>"). The slug is a manifest key and a Composio
 * alias; a bare `sentry` collided with a previous attempt's leftovers and a
 * `-1` suffix collided with the next person's. Random never does. `random`
 * is injectable so tests stay deterministic.
 */
export function proposeConnectorConnectionSlug(
  displayName: string,
  existingSlugs: readonly string[],
  random: () => string = randomConnectorSlugSuffix,
): string {
  const base = normalizeConnectorConnectionSlug(displayName).replace(/[-_]+$/g, '') || 'connector';
  for (;;) {
    const suffix = `-${random()}`;
    const stem = base.slice(0, MAX_CONNECTOR_SLUG_LENGTH - suffix.length).replace(/[-_]+$/g, '');
    const candidate = `${stem}${suffix}`;
    if (isConnectorConnectionSlugAvailable(candidate, existingSlugs)) return candidate;
  }
}

/**
 * The display name a new connection is proposed with: the app's name, or
 * `<name> 2`, `<name> 3` … when the project already has connections to that
 * app (counted by slug stem — the slug is the one field that is unique).
 * So two Sentry connections read "Sentry" and "Sentry 2", never "Sentry" twice.
 */
export function proposeConnectorConnectionName(
  appName: string,
  existingSlugs: readonly string[],
): string {
  const name = appName.trim();
  if (!name) return name;
  const base = normalizeConnectorConnectionSlug(name).replace(/[-_]+$/g, '');
  if (!base) return name;
  const taken = existingSlugs.filter((s) => s === base || s.startsWith(`${base}-`)).length;
  return taken === 0 ? name : `${name} ${taken + 1}`;
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
      // One `_` at most per end: the line above folds every run that holds
      // `_` into one `_`. `_+$` backtracks quadratically (CodeQL js/polynomial-redos).
      .replace(/^_|_$/g, '')
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
  });
}

export function buildDiscoverConnectorDraft(
  template: DiscoverConnectorTemplate,
  input: EasyConnectConnectionInput,
): ConnectorDraftInput {
  const auth = template.auth
    ? {
        type: template.auth.type,
        in: template.auth.in,
        ...(template.auth.name ? { name: template.auth.name } : {}),
        ...(template.auth.prefix ? { prefix: template.auth.prefix } : {}),
      }
    : undefined;
  return createOnlyConnectorDraft({
        slug: input.slug,
        name: input.name.trim(),
        provider: template.provider,
        ...(template.spec ? { spec: template.spec } : {}),
        ...(template.url ? { url: template.url } : {}),
        ...(template.transport ? { transport: template.transport } : {}),
        ...(template.endpoint ? { endpoint: template.endpoint } : {}),
        ...(auth ? { auth } : {}),
      });
}
