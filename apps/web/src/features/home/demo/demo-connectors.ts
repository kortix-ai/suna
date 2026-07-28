/**
 * The curated connector list the logged-out Connectors screen browses.
 *
 * WHY IT IS STATIC. The real catalogue is project-scoped —
 * `listDiscoverIntegrations` and `listPipedreamApps` both hit
 * `/executor/projects/:projectId/…` and answer 401 without a session — so a
 * signed-out visitor cannot be shown live catalogue data. This list is the
 * only honest way to show the shape of the screen before sign-in.
 *
 * WHY EVERY ENTRY IS REAL. This is a demo of real capability, not a mock-up.
 * Each entry names a connector Kortix genuinely supports, and each one is
 * checked against the repo by `demo-connectors.test.ts`, which fails if a name
 * is invented or a slug drifts:
 *
 * - `kind: 'channel'` — the platform must appear in `channelLabel()` in
 *   `apps/api/src/executor/channels.ts`, with the same display name.
 * - `kind: 'app'` — the slug must appear in `meta.capabilities.connectors` of
 *   some item in `packages/starter/templates/marketplace/kortix.registry.json`,
 *   the shipped Kortix marketplace registry.
 *
 * Every description is grounded in what a shipped Kortix template actually
 * does with that connector (the template titles are in the same registry), so
 * no card claims a capability the product does not have.
 *
 * WHAT IS DELIBERATELY ABSENT. No connection state, no "Connected" badge, no
 * tick, no counts. Nothing here belongs to the visitor — they have no account
 * yet. And no total ("3,000+ apps"): the real number is not verifiable here,
 * so the screen says the catalogue is bigger without putting a figure on it.
 */

export type DemoConnectorGroupId = 'communication' | 'workspace' | 'engineering' | 'business';

export interface DemoConnectorGroup {
  id: DemoConnectorGroupId;
  label: string;
}

/** Ordered — the grid renders groups in this order. */
export const DEMO_CONNECTOR_GROUPS: readonly DemoConnectorGroup[] = [
  { id: 'communication', label: 'Communication' },
  { id: 'workspace', label: 'Google Workspace' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'business', label: 'Business' },
];

export interface DemoConnector {
  /** The real slug: a channel platform, or a connector slug from the registry. */
  slug: string;
  name: string;
  /**
   * Domain for the logo. Resolved through the same Google favicon source the
   * signed-in Slack tile already uses, so no logo is bundled or redrawn.
   */
  domain: string;
  /** One line, grounded in a shipped Kortix template. */
  description: string;
  group: DemoConnectorGroupId;
  /**
   * 'channel' is proven by `channels.ts`; 'app' is proven by the marketplace
   * registry. Nothing else is asserted about how a connector authenticates.
   */
  kind: 'channel' | 'app';
}

export const DEMO_CONNECTORS: readonly DemoConnector[] = [
  {
    slug: 'slack',
    name: 'Slack',
    domain: 'slack.com',
    description: 'Start, steer and approve work from a channel or a DM.',
    group: 'communication',
    kind: 'channel',
  },
  {
    slug: 'teams',
    name: 'Microsoft Teams',
    domain: 'microsoft.com',
    description: 'The same channel connection, for teams that live in Teams.',
    group: 'communication',
    kind: 'channel',
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    domain: 'gmail.com',
    description: 'Triage a shared inbox, draft the replies, hold the sends for review.',
    group: 'workspace',
    kind: 'app',
  },
  {
    slug: 'google_calendar',
    name: 'Google Calendar',
    domain: 'calendar.google.com',
    description: 'Find the slot and coordinate an interview loop end to end.',
    group: 'workspace',
    kind: 'app',
  },
  {
    slug: 'google_drive',
    name: 'Google Drive',
    domain: 'drive.google.com',
    description: 'Pull the contracts and reference docs a review needs.',
    group: 'workspace',
    kind: 'app',
  },
  {
    slug: 'google_docs',
    name: 'Google Docs',
    domain: 'docs.google.com',
    description: 'Draft the investor update, the RFP response, the NDA redline.',
    group: 'workspace',
    kind: 'app',
  },
  {
    slug: 'google_sheets',
    name: 'Google Sheets',
    domain: 'sheets.google.com',
    description: 'Reconcile expenses and roll the month-end numbers up.',
    group: 'workspace',
    kind: 'app',
  },
  {
    slug: 'github',
    name: 'GitHub',
    domain: 'github.com',
    description: 'Draft release notes from merged PRs and keep the docs in sync.',
    group: 'engineering',
    kind: 'app',
  },
  {
    slug: 'linear',
    name: 'Linear',
    domain: 'linear.app',
    description: 'Turn scattered feedback and meeting notes into real tickets.',
    group: 'engineering',
    kind: 'app',
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    domain: 'sentry.io',
    description: 'Groom the production error backlog before it becomes a backlog.',
    group: 'engineering',
    kind: 'app',
  },
  {
    slug: 'datadog',
    name: 'Datadog',
    domain: 'datadoghq.com',
    description: 'Triage an on-call alert before anyone gets paged for it.',
    group: 'engineering',
    kind: 'app',
  },
  {
    slug: 'aws',
    name: 'AWS',
    domain: 'aws.amazon.com',
    description: 'Sweep infrastructure daily for drift, and catch cost spikes.',
    group: 'engineering',
    kind: 'app',
  },
  {
    slug: 'postgresql',
    name: 'PostgreSQL',
    domain: 'postgresql.org',
    description: 'Query the warehouse the weekly metrics report is built from.',
    group: 'engineering',
    kind: 'app',
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    domain: 'hubspot.com',
    description: 'Keep the CRM clean and the pipeline moving, deal by deal.',
    group: 'business',
    kind: 'app',
  },
  {
    slug: 'stripe',
    name: 'Stripe',
    domain: 'stripe.com',
    description: 'Chase overdue invoices and recover failed subscription payments.',
    group: 'business',
    kind: 'app',
  },
  {
    slug: 'notion',
    name: 'Notion',
    domain: 'notion.so',
    description: 'Answer policy questions out of the wiki, with the page cited.',
    group: 'business',
    kind: 'app',
  },
  {
    slug: 'greenhouse',
    name: 'Greenhouse',
    domain: 'greenhouse.io',
    description: 'Screen resumes and schedule the loop for the ones worth it.',
    group: 'business',
    kind: 'app',
  },
  {
    slug: 'okta',
    name: 'Okta',
    domain: 'okta.com',
    description: 'Run access requests, and revoke everything on offboarding day.',
    group: 'business',
    kind: 'app',
  },
];

export type DemoConnectorFilter = DemoConnectorGroupId | 'all';

export interface DemoConnectorFilterOption {
  id: DemoConnectorFilter;
  label: string;
}

/**
 * "All" plus one pill per group. Deliberately NOT the reference's
 * Connected/Available pills — a signed-out visitor has connected nothing, so
 * those two pills would be a claim about an account that does not exist.
 */
export const DEMO_CONNECTOR_FILTERS: readonly DemoConnectorFilterOption[] = [
  { id: 'all', label: 'All' },
  ...DEMO_CONNECTOR_GROUPS.map((group) => ({ id: group.id, label: group.label })),
];

/** Matches name, slug and description — the same fields the card shows. */
export function filterDemoConnectors(
  query: string,
  filter: DemoConnectorFilter = 'all',
): DemoConnector[] {
  const needle = query.trim().toLowerCase();
  return DEMO_CONNECTORS.filter((connector) => {
    if (filter !== 'all' && connector.group !== filter) return false;
    if (!needle) return true;
    return (
      connector.name.toLowerCase().includes(needle) ||
      connector.slug.toLowerCase().includes(needle) ||
      connector.description.toLowerCase().includes(needle)
    );
  });
}

export interface DemoConnectorSection {
  group: DemoConnectorGroup;
  connectors: DemoConnector[];
}

/** Groups in {@link DEMO_CONNECTOR_GROUPS} order, dropping the empty ones. */
export function groupDemoConnectors(connectors: readonly DemoConnector[]): DemoConnectorSection[] {
  return DEMO_CONNECTOR_GROUPS.map((group) => ({
    group,
    connectors: connectors.filter((connector) => connector.group === group.id),
  })).filter((section) => section.connectors.length > 0);
}
