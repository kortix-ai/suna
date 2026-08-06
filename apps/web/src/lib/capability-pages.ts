/**
 * Kill-switch for the standalone capability pages (#6054).
 *
 * #6054 moved Connectors, Skills and Commands out of the Customize overlay into
 * their own browsable pages. The rework regressed the experience, so it is
 * hidden until it clears the bar — Marko: "rm it for now / put behind feature
 * flag or similar until not optimal".
 *
 * OFF (the default) restores the previous behaviour exactly: the remaining
 * sections live in the Customize overlay again, the standalone routes bounce
 * there, and nothing in the product links to them. ON gives you #6054 as
 * merged (for Connectors/Skills only).
 *
 * Commands is gone: its standalone page was removed, so it lives only in the
 * Customize overlay (`/customize/commands` via `proj-commands`). Connectors and
 * Skills keep their standalone pages behind this flag.
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
 * Whether the standalone Connectors / Skills pages are live.
 *
 * Read through a function, not a module-level const: `NEXT_PUBLIC_*` is inlined
 * at build time, but a const captured at module eval would also freeze the
 * value for tests that set the variable per-case.
 */
export function capabilityPagesEnabled(): boolean {
  return parseFlagOverride(process.env.NEXT_PUBLIC_CAPABILITY_PAGES) ?? false;
}

/** The sections #6054 moved. Everything gated by this flag is one of these.
 * Commands was removed (its standalone page deleted); it is not a capability
 * section here and lives only in the Customize overlay. */
export const CAPABILITY_SECTIONS = ['connectors', 'skills'] as const;

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
