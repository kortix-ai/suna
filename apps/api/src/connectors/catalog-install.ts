/**
 * Install from the catalogue on the server: the connector draft for one way
 * to connect an app. The CLI (`kortix connectors catalog install`) and the
 * agent's `add_connector` both use it, so they pick the same way the app page
 * recommends. The draft is a connector PROFILE: the project's entry in
 * `kortix.yaml`, where its accounts, who may use them and its tool rules live.
 */
import type { ConnectorCatalogDetail, ConnectorSurfaceVariant } from './connector-catalog';

export class CatalogInstallError extends Error {}

/** A connector slug from a name: lower case, letters, digits, `-` and `_`. */
export function catalogSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 63);
}

/** The way to install: `way` by id, else the recommended one. */
export function catalogWay(detail: ConnectorCatalogDetail, way?: string): ConnectorSurfaceVariant {
  const installable = detail.variants.filter((variant) => variant.connector || variant.kind === 'composio');
  const picked = way
    ? detail.variants.find((variant) => variant.id === way)
    : (installable.find((variant) => variant.recommended) ?? installable[0]);
  if (!picked) {
    throw new CatalogInstallError(
      way ? `"${way}" is not a way to connect ${detail.item.name}` : `${detail.item.name} has no way Kortix can install`,
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
