/**
 * Connector catalogue browse sections: the curated category buckets and the
 * per-section picks, shared by the API and the web app.
 *
 * The API groups the COMPLETE Discover catalogue with these rules, so a
 * section heading states the category's true size. The web app renders and
 * filters with the same rules, so a heading and the grid its "View all" opens
 * can never disagree about what a category contains. Framework-free on purpose.
 */

export const OTHER = 'Other';

/**
 * The synthetic first section. Not a catalogue category — see `catalogSections`
 * in `catalog-entry.ts`, which re-exports this.
 *
 * Defined here rather than there because `catalogCategoryKeys` below has to
 * exclude it, and `catalog-entry.ts` already imports from this module — the
 * other direction would be a cycle.
 */
export const POPULAR_SECTION = 'popular';

/**
 * Fold the spellings the two catalogues disagree on into one comparable token:
 * `Data Analytics`, `data-analytics` and `data_analytics` all become
 * `dataanalytics`.
 *
 * Every token in a section's `match` list is already in this form, and every
 * raw category is put through this before it is looked up. That is what lets
 * the ordering survive contact with the live feeds: these categories are
 * third-party strings nothing in this repo enumerates or controls, so matching
 * them literally would break the first time Pipedream shipped `Sales & CRM`
 * where the Discover feed ships `sales-crm`.
 */
function foldCategory(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface CatalogSectionDef {
  /** Stable key, and the value the category `Select` round-trips. Must not
   *  start with a space — that is `ALL_CATEGORIES`' sentinel. */
  key: string;
  /** The section heading. Ours to choose: these are curated groupings, not
   *  catalogue values, so the heading does not have to echo whatever a
   *  provider happened to name its bucket. */
  title: string;
  /** Folded raw categories this section claims. A token that matches nothing
   *  in the live feeds costs nothing — the section stays empty and is never
   *  emitted. */
  match: readonly string[];
}

/**
 * The browse order, chosen rather than measured.
 *
 * **Why this exists.** Sections used to be ranked by bucket size alone, so
 * whichever category the upstream feed happened to fill most took the top slot
 * — in practice "Business management", a heading nobody picked and few people
 * are shopping for. Size is a fact about the feed, not a statement about what
 * someone browsing should see first.
 *
 * **The order.** Getting work done first, then the tools a team runs the
 * business on, then what a technical user goes looking for deliberately.
 * Developer tools is last on purpose: someone who wants GitHub searches for
 * GitHub, while someone browsing is better served by every non-technical row
 * above it.
 *
 * Anything the catalogue publishes that no section claims still renders. It
 * falls through to the tail, ranked by size the way everything used to be,
 * with `Other` below that. Nothing is hidden by being absent from this list;
 * it is only ranked beneath what is present.
 */
export const CURATED_SECTIONS: readonly CatalogSectionDef[] = [
  {
    key: 'productivity',
    title: 'Productivity',
    match: [
      'productivity',
      'projectmanagement',
      'taskmanagement',
      'tasks',
      'todo',
      'notes',
      'notetaking',
      'documents',
      'docs',
      'knowledgebase',
      'scheduling',
      'calendar',
      'timetracking',
      'drivesandfiles',
      'onlinestorage',
      'filestorage',
      'filemanagement',
      'forms',
      'formsandsurveys',
      'surveys',
    ],
  },
  {
    key: 'operations',
    title: 'Operations',
    match: [
      'operations',
      'businessoperations',
      'workflow',
      'workflowautomation',
      'hr',
      'humanresources',
      'peopleops',
      'recruiting',
      'hiring',
      'legal',
      'contracts',
      'esignature',
      'signature',
      'logistics',
      'shipping',
      'inventory',
      'realestate',
    ],
  },
  {
    key: 'finance',
    title: 'Finance',
    match: [
      'finance',
      'financial',
      'financialservices',
      'accounting',
      'bookkeeping',
      'payments',
      'banking',
      'invoicing',
      'billing',
      'expensemanagement',
      'expenses',
      'payroll',
      'tax',
      'crypto',
      'cryptocurrency',
    ],
  },
  {
    key: 'data-analytics',
    title: 'Data & analytics',
    match: [
      'analytics',
      'dataanalytics',
      'data',
      'businessintelligence',
      'bi',
      'reporting',
      'dashboards',
      'productanalytics',
      'webanalytics',
      'datawarehouse',
      'etl',
    ],
  },
  {
    key: 'communication',
    title: 'Communication',
    match: [
      'communication',
      'communications',
      'email',
      'messaging',
      'chat',
      'sms',
      'voice',
      'telephony',
      'videoconferencing',
      'streamingandvideo',
      'meetings',
      'notifications',
    ],
  },
  {
    key: 'sales-marketing',
    title: 'Sales & marketing',
    match: [
      'sales',
      'crm',
      'salescrm',
      'salesandcrm',
      'salesandmarketing',
      'marketing',
      'marketingautomation',
      'emailmarketing',
      'advertising',
      'ads',
      'socialmedia',
      'seo',
      'leadgeneration',
      'events',
    ],
  },
  {
    key: 'customer-support',
    title: 'Customer support',
    match: ['support', 'customersupport', 'customersuccess', 'helpdesk', 'ticketing'],
  },
  {
    key: 'commerce',
    title: 'Commerce',
    match: ['ecommerce', 'commerce', 'retail', 'pointofsale', 'subscriptions', 'marketplace'],
  },
  {
    key: 'content-design',
    title: 'Content & design',
    match: [
      'design',
      'media',
      'mediaandcontent',
      'content',
      'contentmanagement',
      'cms',
      'video',
      'images',
      'audio',
      'publishing',
      'writing',
      'websitebuilders',
    ],
  },
  {
    key: 'developer-tools',
    title: 'Developer tools',
    match: [
      'developer',
      'developertools',
      'engineering',
      'code',
      'devops',
      'monitoring',
      'observability',
      'logging',
      'security',
      'itandsecurity',
      'it',
      'computerit',
      'hosting',
      'database',
      'databases',
      'api',
      'apis',
      'versioncontrol',
      'testing',
      'ai',
      'aiml',
      'artificialintelligence',
      'machinelearning',
    ],
  },
];

/** Folded raw category -> curated section key. Built once at module load. */
const CLAIMED_BY = new Map<string, string>(
  CURATED_SECTIONS.flatMap((section) =>
    section.match.map((token) => [token, section.key] as const),
  ),
);

const CURATED_RANK = new Map<string, number>(
  CURATED_SECTIONS.map((section, index) => [section.key, index]),
);
const CURATED_TITLE = new Map<string, string>(
  CURATED_SECTIONS.map((section) => [section.key, section.title]),
);

/** Everything uncurated shares one rank, so the size rule still orders the
 *  tail among itself. `Other` sits below all of it. */
const UNCURATED_RANK = CURATED_SECTIONS.length;
const OTHER_RANK = UNCURATED_RANK + 1;

function sectionRank(key: string): number {
  if (key === OTHER) return OTHER_RANK;
  return CURATED_RANK.get(key) ?? UNCURATED_RANK;
}

/**
 * The section a raw catalogue category belongs to: a curated key when one
 * claims it, otherwise the trimmed raw value, which then becomes its own
 * section exactly as before.
 */
export function sectionKeyForCategory(raw: string): string {
  const trimmed = raw.trim();
  return CLAIMED_BY.get(foldCategory(trimmed)) ?? trimmed;
}

/**
 * A section key as a heading. Curated sections use the title we chose;
 * anything else falls back to the catalogue's own value, humanized.
 */
export function sectionTitle(key: string): string {
  return CURATED_TITLE.get(key) ?? humanizeCategory(key);
}

/**
 * The sections one item belongs to — the single definition of membership, used
 * both to build the buckets and to count a category without building them.
 *
 * Categories are trimmed and blank ones are dropped before anything else.
 * `categories: ['']` is not hypothetical — `Malwarebytes` ships exactly that in
 * the live catalogue, and a plain `length > 0` check would accept the empty
 * string as a category and render a section under a blank heading. Trimming
 * also stops `' data'` and `'data '` from forking one category into two
 * adjacent sections. An item left with nothing after that is genuinely
 * uncategorized and lands in `Other`.
 *
 * A `Set` over the MAPPED keys, not the raw names: `project-management` and
 * `task-management` are two distinct raw categories that both fold into
 * Productivity, and an app claiming both would otherwise render twice in that
 * grid under two identical React keys.
 */
export function sectionKeysForEntry(
  categories: readonly string[],
  opts: { raw?: boolean } = {},
): Set<string> {
  const named: string[] = [];
  for (const category of categories) {
    const trimmed = category.trim();
    // `raw` keeps the catalogue's own slug as the section key instead of folding
    // it into a curated bucket. Required wherever a section heading doubles as a
    // server-side filter value: the curated keys are ours, and asking the
    // provider for `sales-marketing` (which claims `crm` + `marketing`) returns
    // zero, which the grid renders as "Catalogue unavailable".
    if (trimmed.length > 0) named.push(opts.raw ? trimmed : sectionKeyForCategory(trimmed));
  }
  return named.length > 0 ? new Set(named) : new Set([OTHER]);
}

/**
 * How many of `items` a section holds, without bucketing the rest.
 *
 * Shares `sectionKeysForEntry` with `groupIntoSections`, so the count that
 * decides whether to fetch another page and the grid that page fills can never
 * disagree about what is in a category. Counting with a second, hand-written
 * membership rule is how a page ends up fetching forever against a target the
 * grid has already met.
 */
export function countInSection<T>(
  items: readonly T[],
  getCategories: (item: T) => readonly string[],
  section: string,
): number {
  let count = 0;
  for (const item of items) {
    if (sectionKeysForEntry(getCategories(item)).has(section)) count++;
  }
  return count;
}

/**
 * Bucket catalog items into browse sections, in `CURATED_SECTIONS` order.
 *
 * Items are duplicated across the sections they claim on purpose — that is how
 * a browse surface works, and `DiscoverConnector.categories` is genuinely
 * multi-valued. What must NOT duplicate is one item inside one section;
 * `sectionKeysForEntry` owns that rule and the blank-category handling.
 *
 * Sorting is rank first, size second. Curated ranks are unique, so the size
 * rule can never reorder them — it orders only the uncurated tail, which is
 * what this function did for every section before there was a rank.
 */
export function groupIntoSections<T>(
  items: readonly T[],
  getCategories: (item: T) => readonly string[],
  opts: { raw?: boolean } = {},
): Array<{ category: string; items: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    for (const key of sectionKeysForEntry(getCategories(item), opts)) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
  }
  return [...buckets.entries()]
    .map(([category, bucketItems]) => ({ category, items: bucketItems }))
    .sort((a, b) => {
      const rank = sectionRank(a.category) - sectionRank(b.category);
      if (rank !== 0) return rank;
      if (a.items.length !== b.items.length) return b.items.length - a.items.length;
      return a.category.localeCompare(b.category);
    });
}

/**
 * A catalogue category as a section heading. The values arrive kebab-case
 * (`sales-and-marketing`, `financial-services`), which reads as broken markup
 * when rendered raw. Hyphen -> space matches the existing transform at
 * `lib/utils/kortix-system-tags.ts:131`.
 *
 * Only the first character is capitalized; the tail is left exactly as the
 * catalogue published it. Lowercasing the tail would produce sentence case for
 * kebab values but turn any acronym (`CRM`) into `Crm`, and this catalogue is
 * third-party data whose casing we do not control.
 *
 * Reached through `sectionTitle` for anything no curated section claimed.
 */
export function humanizeCategory(raw: string): string {
  const spaced = raw.trim().replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

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
