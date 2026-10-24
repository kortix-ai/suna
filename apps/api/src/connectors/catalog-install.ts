/**
 * Install from the catalogue on the server: the connector draft for one way
 * to connect an app. The CLI (`kortix connectors catalog install`) and the
 * agent's `add_connector` both use it, so they pick the same way the app page
 * recommends. The draft is a connector PROFILE: the project's entry in
 * `kortix.yaml`, where its accounts, who may use them and its tool rules live.
 */
import { canonicalCatalogId, type ConnectorCatalogDetail, type ConnectorSurfaceVariant } from './connector-catalog';

export class CatalogInstallError extends Error {}

/** How each Kortix integration is set up outside the web. Telegram has no CLI command yet. */
const KORTIX_SETUP_COMMAND: Record<string, string> = {
  slack: 'kortix channels connect',
  teams: 'kortix channels connect --platform teams',
  email: 'kortix channels email connect',
  computer: 'npx --yes @kortix/agent-tunnel@latest connect',
};

/** A connector slug from a name: lower case, letters, digits, `-` and `_`. */
export function catalogSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 63);
}

/** The way to install: `way` by id, else the recommended one. */
export function catalogWay(detail: ConnectorCatalogDetail, requestedWay?: string): ConnectorSurfaceVariant {
  const way = requestedWay ? canonicalCatalogId(requestedWay) : undefined;
  const installable = detail.variants.filter((variant) => variant.connector || variant.kind === 'composio');
  const recommended = detail.variants.find((variant) => variant.recommended);
  // A recommended Kortix integration is the answer, not a reason to install the next way.
  const picked = way
    ? detail.variants.find((variant) => variant.id === way)
    : recommended?.kind === 'kortix'
      ? recommended
      : (installable.find((variant) => variant.recommended) ?? installable[0]);
  if (!picked) {
    throw new CatalogInstallError(
      way ? `"${way}" is not a way to connect ${detail.item.name}` : `${detail.item.name} has no way Kortix can install`,
    );
  }
  if (picked.kind === 'kortix') {
    const command = KORTIX_SETUP_COMMAND[picked.kortix?.app ?? ''];
    throw new CatalogInstallError(
      `${picked.name} is built into Kortix: set it up on its page${command ? ` or with \`${command}\`` : ''}, not installed as a connector`,
    );
  }
  if (!picked.connector && picked.kind !== 'composio') {
    throw new CatalogInstallError(`${picked.name} (${picked.kind}) cannot be installed by Kortix; see ${picked.docs ?? picked.url ?? 'its docs'}`);
  }
  return picked;
}

/** The `POST /connectors` body for one way, named `name` (default: the app's name). */
export function catalogInstallDraft(
  detail: ConnectorCatalogDetail,
  input: { way?: string; name?: string; slug?: string } = {},
): { draft: Record<string, unknown>; way: ConnectorSurfaceVariant } {
  const way = catalogWay(detail, input.way);
  const name = input.name?.trim() || detail.item.name;
  const slug = input.slug?.trim() || catalogSlug(name);
  if (!slug) throw new CatalogInstallError('the connector needs a name with a letter or a digit');
  if (way.kind === 'composio') {
    return {
      way,
      draft: { slug, name, provider: 'composio', app: way.composio?.slug ?? detail.item.slug, account: 'default', create_only: true },
    };
  }
  const t = way.connector!;
  return {
    way,
    draft: {
      slug,
      name,
      provider: t.provider,
      ...(t.url ? { url: t.url } : {}),
      ...(t.transport ? { transport: t.transport } : {}),
      ...(t.endpoint ? { endpoint: t.endpoint } : {}),
      ...(t.spec ? { spec: t.spec } : {}),
      ...(t.auth ? { auth: { type: t.auth.type, in: t.auth.in, ...(t.auth.name ? { name: t.auth.name } : {}), ...(t.auth.prefix ? { prefix: t.auth.prefix } : {}) } } : {}),
      create_only: true,
    },
  };
}
