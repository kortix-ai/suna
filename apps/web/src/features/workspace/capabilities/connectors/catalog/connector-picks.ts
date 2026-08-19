import { CURATED_SECTIONS } from './connector-categories';

/**
 * Fold a slug or display name into one comparable token: `Google Sheets`,
 * `google_sheets` and `google-sheets` all become `googlesheets`.
 *
 * Same transform `connector-categories.ts` applies to categories, and for the
 * same reason — these are third-party strings from two feeds that spell the
 * same product differently. Every token in `CATEGORY_PICKS` is already in this
 * form, asserted in the tests.
 */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The tools a person browsing a category should meet first, in the order they
 * should meet them.
 *
 * **Why a hand-written list.** The catalogue is ~5,758 apps and the feed's own
 * order is not an editorial judgement — it is whatever the provider returns.
 * Left alone, a category's first six cards are arbitrary, and someone who does
 * not already know the space cannot tell a household name from a long-tail
 * entry. These lists put the recognisable ones in front.
 *
 * **Keys are `CURATED_SECTIONS` keys**, not a second vocabulary — a key that
 * is not a real section is a test failure, so this cannot drift into naming
 * sections that no longer exist.
 *
 * **Entries are matched against an app's folded slug OR its folded name**, so
 * one token covers both catalogues. An entry that matches nothing is inert: it
 * pins nothing, hides nothing, and cannot duplicate a card. That is the whole
 * safety story for a list written from product knowledge rather than from a
 * catalogue dump — being wrong costs a pin, never a render.
 *
 * An app only reaches a section if the FEED puts it in that category, so
 * pinning `slack` under both communication and productivity is not a conflict;
 * whichever section Slack actually lands in is the one where its pin applies.
 */
export const CATEGORY_PICKS: Record<string, readonly string[]> = {
  productivity: [
    'notion',
    'googledrive',
    'googlesheets',
    'googledocs',
    'googlecalendar',
    'trello',
    'asana',
    'airtable',
    'dropbox',
    'clickup',
    'monday',
    'todoist',
    'evernote',
    'onedrive',
    'box',
    'coda',
    'calendly',
  ],
  operations: [
    'docusign',
    'bamboohr',
    'greenhouse',
    'lever',
    'gusto',
    'rippling',
    'workday',
    'pandadoc',
    'jotform',
    'typeform',
    'shippo',
  ],
  finance: [
    'stripe',
    'quickbooks',
    'xero',
    'paypal',
    'square',
    'brex',
    'ramp',
    'wise',
    'plaid',
    'chargebee',
    'freshbooks',
    'expensify',
  ],
  'data-analytics': [
    'googleanalytics',
    'mixpanel',
    'amplitude',
    'posthog',
    'segment',
    'looker',
    'tableau',
    'powerbi',
    'snowflake',
    'bigquery',
    'metabase',
  ],
  communication: [
    'slack',
    'gmail',
    'microsoftteams',
    'discord',
    'zoom',
    'outlook',
    'twilio',
    'sendgrid',
    'telegram',
    'whatsapp',
    'mailgun',
  ],
  'sales-marketing': [
    'hubspot',
    'salesforce',
    'mailchimp',
    'klaviyo',
    'pipedrive',
    'activecampaign',
    'googleads',
    'facebookads',
    'linkedin',
    'brevo',
    'customerio',
    'marketo',
  ],
  'customer-support': ['zendesk', 'intercom', 'freshdesk', 'helpscout', 'front', 'crisp'],
  commerce: ['shopify', 'woocommerce', 'bigcommerce', 'squarespace', 'etsy', 'amazon'],
  'content-design': [
    'figma',
    'canva',
    'webflow',
    'wordpress',
    'youtube',
    'contentful',
    'vimeo',
    'cloudinary',
    'framer',
  ],
  'developer-tools': [
    'github',
    'linear',
    'gitlab',
    'jira',
    'sentry',
    'vercel',
    'netlify',
    'openai',
    'anthropic',
    'supabase',
    'datadog',
    'pagerduty',
    'circleci',
    'bitbucket',
    'cloudflare',
    'aws',
  ],
};

/** Folded token -> its position, per section. Built once at module load so
 *  sorting a section is a map lookup per item rather than a list scan. */
const PICK_RANK = new Map<string, Map<string, number>>(
  Object.entries(CATEGORY_PICKS).map(([section, picks]) => [
    section,
    new Map(picks.map((token, index) => [token, index])),
  ]),
);

/** Sorts after every pinned entry. `Number.MAX_SAFE_INTEGER` rather than
 *  `Infinity` so the subtraction in the comparator stays a real number —
 *  `Infinity - Infinity` is `NaN`, and a `NaN` comparator silently leaves the
 *  array in an arbitrary order. */
export const UNPINNED_RANK = Number.MAX_SAFE_INTEGER;

/**
 * Where an app sits in its section's pick list, or `UNPINNED_RANK`.
 *
 * Slug and name are both tried because the two catalogues disagree about which
 * one carries the recognisable string — Easy Connect ships `google_sheets` as
 * a slug, the Discover feed can ship an opaque id with `Google Sheets` as the
 * name. One token covers both.
 */
export function pinRank(sectionKey: string, app: { slug: string; name: string }): number {
  const ranks = PICK_RANK.get(sectionKey);
  if (!ranks) return UNPINNED_RANK;
  return ranks.get(fold(app.slug)) ?? ranks.get(fold(app.name)) ?? UNPINNED_RANK;
}

/**
 * A section's items with its picks floated to the top, in pick order, and
 * everything else left exactly as the feed returned it.
 *
 * `Array.prototype.sort` is stable (required since ES2019), which is what
 * preserves feed order among the unpinned rather than scrambling them into an
 * order nobody chose.
 */
export function sortByPicks<T extends { slug: string; name: string }>(
  sectionKey: string,
  items: readonly T[],
): T[] {
  if (!PICK_RANK.has(sectionKey)) return [...items];
  return [...items].sort((a, b) => pinRank(sectionKey, a) - pinRank(sectionKey, b));
}

/** Every section key that carries picks. Exported for the hygiene test that
 *  checks them against `CURATED_SECTIONS`. */
export const PICKED_SECTION_KEYS = Object.keys(CATEGORY_PICKS);

/** The curated sections, for the same test. Re-exported so the test does not
 *  need to import two modules to check one invariant. */
export { CURATED_SECTIONS };
