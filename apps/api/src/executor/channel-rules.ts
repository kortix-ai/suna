/**
 * Pure rules for the Slack-as-a-first-class-channel consolidation. No DB / git
 * imports so they're cheap to unit test. Used by:
 *   - db-deps.ts      → hide a superseded user `slack` connector from listings
 *   - channel-manifest.ts → declare/undeclare the channel connector in kortix.toml
 */
import { SLACK_RESERVED_SLUG, type ChannelPlatform } from '../projects/connectors';

type Entry = Record<string, unknown>;

/** A declared `[[connectors]]` entry (or DB row shape) that is the channel for `platform`. */
function isChannelFor(e: Entry, platform: ChannelPlatform): boolean {
  return (
    typeof e?.provider === 'string' &&
    e.provider.toLowerCase() === 'channel' &&
    typeof e?.platform === 'string' &&
    (e.platform as string).toLowerCase() === platform
  );
}

/**
 * Slack is a first-class channel connector. When a project has BOTH the
 * platform-owned Slack channel (`kortix_slack`) AND a legacy user-defined
 * `slack` connector (e.g. a Pipedream Slack added before the picker hid it, like
 * older projects still carry), hide the legacy one so there's exactly one
 * "Slack". Native Slack actions already route to the channel (gateway
 * `resolveConnectorForCall`), so nothing is lost. Non-destructive — the row
 * stays; it's just not listed in the dashboard or offered to the agent.
 */
export function hideSupersededSlack<T extends { slug: string; providerType: string }>(conns: T[]): T[] {
  const hasChannelSlack = conns.some(
    (c) => c.providerType === 'channel' && c.slug === SLACK_RESERVED_SLUG,
  );
  if (!hasChannelSlack) return conns;
  return conns.filter((c) => !(c.slug === 'slack' && c.providerType !== 'channel'));
}

/**
 * Return the connector list with the reserved channel declaration present:
 * convert a legacy channel entry that's on the wrong slug (e.g. the old public
 * `slack`) to the reserved slug, then add the declaration if missing. `changed`
 * says whether anything was rewritten — callers commit only when true, so it's
 * idempotent. Mutates entries in place for the rename (same objects the manifest
 * holds), matching the trigger CRUD path. A user-defined Pipedream `slack` is
 * left untouched (it's hidden from the list, not rewritten).
 */
export function withChannelDeclaration(
  connectors: Entry[],
  platform: ChannelPlatform,
  slug: string,
  name?: string,
): { connectors: Entry[]; changed: boolean } {
  let changed = false;
  for (const e of connectors) {
    if (isChannelFor(e, platform) && e.slug !== slug) {
      e.slug = slug;
      changed = true;
    }
  }
  if (!connectors.some((e) => e?.slug === slug)) {
    // `name` gives the connector a human label ("Slack") so the dashboard shows
    // it as a normal connector — without it the parser falls back to the slug
    // ("kortix_slack"). Set only on the freshly-added entry so a later user
    // rename is never clobbered on reconcile.
    connectors.push({ slug, provider: 'channel', platform, ...(name ? { name } : {}) });
    changed = true;
  }
  return { connectors, changed };
}

/** Return the connector list without the reserved channel declaration for `platform`. */
export function withoutChannelDeclaration(
  connectors: Entry[],
  platform: ChannelPlatform,
  slug: string,
): { connectors: Entry[]; changed: boolean } {
  const next = connectors.filter((e) => e?.slug !== slug && !isChannelFor(e, platform));
  return { connectors: next, changed: next.length !== connectors.length };
}
