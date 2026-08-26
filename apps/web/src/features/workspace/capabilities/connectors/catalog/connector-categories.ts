/**
 * Two rows of the widest grid (`xl:grid-cols-3`). The live catalogue makes
 * this load-bearing rather than theoretical: one page of
 * `listDiscoverConnectors` puts 26 of its 48 items under `productivity`
 * alone, so a category section renders its first 6 and defers the rest to
 * "View all".
 */
export const CATEGORY_ROW_CAP = 6;

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
 * The category `Select`'s "no category" value. Radix `SelectItem` cannot hold
 * an empty string, so this needs a sentinel no real category can collide with.
 * `groupIntoSections` trims every key and every curated key is
 * lowercase-kebab, so a leading space is unreachable by construction — this is
 * provably distinct rather than merely unlikely.
 */
export const ALL_CATEGORIES = ' all';

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
  const spaced = raw.trim().replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
