import type { DiscoverConnectorTemplate, DiscoverConnectorVariant } from '@kortix/sdk';

/** A published surface that carries the template Install builds a connector from. */
export interface InstallableVariant {
  id: string;
  kind: DiscoverConnectorVariant['kind'];
  name: string;
  template: DiscoverConnectorTemplate;
}

/** The surfaces Install can use: MCP first, the rest in catalogue order. */
export function installableVariants(
  variants: readonly DiscoverConnectorVariant[],
): InstallableVariant[] {
  const usable = variants.flatMap((variant) =>
    variant.connector
      ? [{ id: variant.id, kind: variant.kind, name: variant.name, template: variant.connector }]
      : [],
  );
  return [
    ...usable.filter((variant) => variant.kind === 'mcp'),
    ...usable.filter((variant) => variant.kind !== 'mcp'),
  ];
}

/**
 * The name Install gives the connector of one surface, and looks an installed
 * one up by. Only the primary surface (index 0 of `installableVariants`, the
 * one `pickSurface` returns) takes the app's name. Every other surface takes
 * its own name, qualified by the app: surface names are not unique across apps
 * (the catalogue falls back to `Surface <n>`), and an unqualified one would
 * let two apps share a connector. A surface with no name of its own, or named
 * exactly as the app, is numbered, so it never takes the primary's name.
 */
export function surfaceInstallName(
  appName: string,
  variant: InstallableVariant,
  index: number,
): string {
  if (index === 0) return appName;
  const app = appName.trim();
  const name = variant.name.trim();
  if (!name || name.toLowerCase() === app.toLowerCase()) return `${appName} ${index + 1}`;
  return name.toLowerCase().startsWith(app.toLowerCase()) ? name : `${appName} ${name}`;
}

/** The surface Install uses without asking. */
export function pickSurface(
  variants: readonly DiscoverConnectorVariant[],
): InstallableVariant | null {
  return installableVariants(variants)[0] ?? null;
}
