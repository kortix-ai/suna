/**
 * Kill-switch for the standalone capability pages (#6054).
 *
 * #6054 moved Connectors, Skills and Commands out of the Customize overlay into
 * their own browsable pages. The rework regressed the experience, so it is
 * hidden until it clears the bar — Marko: "rm it for now / put behind feature
 * flag or similar until not optimal".
 *
 * OFF (the default) restores the previous behaviour exactly: the three sections
 * live in the Customize overlay again, the standalone routes bounce there, and
 * nothing in the product links to them. ON gives you #6054 as merged.
 *
 * Nothing was deleted or reverted — the pages and their tests stay in the tree,
 * and the new page components already render the same underlying views, so the
 * flag only decides which shell you get.
 *
 * Enable with `NEXT_PUBLIC_CAPABILITY_PAGES=true`.
 *
 * Deliberately web-local rather than a `@kortix/sdk` FeatureFlags entry: the
 * SDK's exported names are a published API contract, and this switch is a
 * temporary rollout gate for one web surface, not a capability the SDK offers.
 * It reuses the SDK's parser so the env-var semantics match every other flag.
 */
import { parseFlagOverride } from '@kortix/sdk';

/**
 * Whether the standalone Connectors / Skills / Commands pages are live.
 *
 * Read through a function, not a module-level const: `NEXT_PUBLIC_*` is inlined
 * at build time, but a const captured at module eval would also freeze the
 * value for tests that set the variable per-case.
 */
export function capabilityPagesEnabled(): boolean {
  return parseFlagOverride(process.env.NEXT_PUBLIC_CAPABILITY_PAGES) ?? false;
}

/** The three sections #6054 moved. Everything gated by this flag is one of these. */
export const CAPABILITY_SECTIONS = ['connectors', 'skills', 'commands'] as const;

export type CapabilitySection = (typeof CAPABILITY_SECTIONS)[number];

export function isCapabilitySection(value: string | null | undefined): value is CapabilitySection {
  return !!value && (CAPABILITY_SECTIONS as readonly string[]).includes(value);
}

/** Where a capability section lives right now, given the flag. */
export function capabilitySectionHref(projectId: string, section: CapabilitySection): string {
  return capabilityPagesEnabled()
    ? `/projects/${projectId}/${section}`
    : `/projects/${projectId}/customize/${section}`;
}
