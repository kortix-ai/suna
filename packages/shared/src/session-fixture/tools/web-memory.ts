/**
 * Web, media, memory, and context-management tool calls for the session parity
 * fixture.
 *
 * Output shapes come from the tool sources and the parsers the renderers call:
 * - `web_search`, `scrape_webpage`, `image_search`: the starter tools in
 *   `packages/starter/src/embedded.generated.json`
 *   (`.kortix/opencode/tools/*.ts`), pretty-printed with `JSON.stringify(…, null, 2)`
 *   exactly as those tools return them.
 * - `webfetch`: the OpenCode built-in (markdown / html body as the output).
 * - image/video/presentation: `parseImageOutput`, `parseVideoOutput` (mobile),
 *   `parsePresentationOutput` (`@kortix/sdk`).
 * - memory: `parseMemoryView` (`@kortix/sdk`), `parseMemorySearchOutput`,
 *   `parseMemoryEntryOutput` (web `lib/utils`, mobile `lib/session/tools` ports).
 * - DCP (`context_info`, `compress`, `distill`, `prune`): plain text, rendered
 *   through `ToolOutputFallback` on both surfaces.
 *
 * No output carries a top-level `error` field or `success: false` unless the
 * spec is the embedded-failure case: `detectEmbeddedFailure`
 * (`packages/sdk/src/core/turns/classify.ts`) turns either into an error row.
 */

import type { FixtureToolGroup } from '../types';

// ─── web_search ──────────────────────────────────────────────────────────────

const SEARCH_Q1 = 'postgres advisory locks node.js background jobs';
const SEARCH_Q2 = 'pg_try_advisory_xact_lock vs pg_advisory_lock';

const WEB_SEARCH_OUTPUT = JSON.stringify(
  {
    batch_mode: true,
    total_queries: 2,
    results: [
      {
        query: SEARCH_Q1,
        success: true,
        answer:
          'Advisory locks let an application take a named lock inside Postgres without locking a table row. Background workers call pg_try_advisory_lock(key) and skip the job when it returns false, so only one worker runs a given job at a time.',
        results: [
          {
            title: 'PostgreSQL: Documentation: 13.3. Explicit Locking',
            url: 'https://www.postgresql.org/docs/current/explicit-locking.html',
            snippet:
              'PostgreSQL provides a means for creating locks that have application-defined meanings. These are called advisory locks, as the system does not enforce their use.',
            score: 0.91,
            published_date: '',
          },
          {
            title: 'Using advisory locks to run a cron job on exactly one instance',
            url: 'https://www.crunchydata.com/blog/postgres-advisory-locks-for-cron',
            snippet:
              'Wrap the job in pg_try_advisory_lock with a stable bigint key. Every replica attempts the lock; one wins and the others exit immediately.',
            score: 0.84,
            published_date: '2025-11-04',
          },
          {
            title: 'Transactions – node-postgres',
            url: 'https://node-postgres.com/features/transactions',
            snippet:
              'You must use the same client instance for all statements within a transaction. Check out a client from the pool with pool.connect().',
            score: 0.72,
            published_date: '',
          },
          {
            title: 'graphile/worker: High performance Node.js/PostgreSQL job queue',
            url: 'https://github.com/graphile/worker',
            snippet:
              'Job queue for PostgreSQL running on Node.js. Uses LISTEN/NOTIFY and SKIP LOCKED to fetch jobs with low latency.',
            score: 0.66,
            published_date: '2026-06-18',
          },
        ],
        images: [],
      },
      {
        query: SEARCH_Q2,
        success: true,
        answer:
          'pg_advisory_lock holds the lock until an explicit unlock or session end. pg_try_advisory_xact_lock releases it automatically at transaction end and returns false instead of waiting.',
        results: [
          {
            title: 'PostgreSQL: Documentation: 9.28. System Administration Functions',
            url: 'https://www.postgresql.org/docs/current/functions-admin.html',
            snippet:
              'pg_try_advisory_xact_lock ( key bigint ) → boolean. Obtains an exclusive transaction-level advisory lock if available.',
            score: 0.93,
            published_date: '',
          },
          {
            title: 'Session vs transaction advisory locks with PgBouncer',
            url: 'https://www.pgbouncer.org/features.html',
            snippet:
              'In transaction pooling mode, session-level advisory locks are not supported. Use transaction-level locks instead.',
            score: 0.81,
            published_date: '',
          },
          {
            title: 'Advisory locks leak when a pooled connection is reused',
            url: 'https://stackoverflow.com/questions/55029107/postgres-advisory-lock-connection-pool',
            snippet:
              'A session lock taken on a pooled connection survives release() back to the pool. The next checkout inherits the lock.',
            score: 0.77,
            published_date: '2024-03-12',
          },
        ],
        images: [],
      },
    ],
  },
  null,
  2,
);

const WEB_SEARCH_PAYMENT_FAILURE_OUTPUT = JSON.stringify(
  {
    query: 'acme-dashboard competitor pricing 2026',
    success: false,
    error: 'Payment Required: Insufficient credits',
  },
  null,
  2,
);

// ─── webfetch ────────────────────────────────────────────────────────────────

const FETCH_MD_URL = 'https://www.postgresql.org/docs/current/functions-admin.html';

const WEB_FETCH_MARKDOWN_OUTPUT = `# 9.28.10. Advisory Lock Functions

The functions shown in the table below manage advisory locks. Advisory locks are held either at **session** level or at **transaction** level.

| Function | Waits | Released |
| --- | --- | --- |
| \`pg_advisory_lock(key bigint)\` | yes | explicit unlock or session end |
| \`pg_try_advisory_lock(key bigint)\` | no, returns \`false\` | explicit unlock or session end |
| \`pg_advisory_xact_lock(key bigint)\` | yes | transaction end |
| \`pg_try_advisory_xact_lock(key bigint)\` | no, returns \`false\` | transaction end |

A transaction-level lock cannot be released explicitly. If a session already holds a lock, extra requests always succeed and stack: a session lock taken twice must be unlocked twice.

\`\`\`sql
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtext('billing-sync'));
-- false: another worker owns the job, exit
COMMIT;
\`\`\`

> Take care with \`LIMIT\` in a query that also takes advisory locks: the lock can be acquired for rows the \`LIMIT\` later discards.`;

const FETCH_HTML_URL = 'https://supabase.com/pricing';

const WEB_FETCH_HTML_OUTPUT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pricing &amp; fees | Supabase</title>
<style>body{font-family:system-ui}</style>
<script>window.__NEXT_DATA__={}</script>
</head>
<body>
<h1>Predictable pricing, designed to scale</h1>
<p>Start building for free, collaborate with your team, then scale to millions of users.</p>
<section>
<h2>Free</h2>
<p>$0 / month. 500 MB database, 50,000 monthly active users, 1 GB file storage.</p>
<h2>Pro</h2>
<p>From $25 / month. 8 GB database included, 100,000 monthly active users, daily backups kept for 7 days.</p>
<h2>Team</h2>
<p>From $599 / month. SOC 2, SSO for the dashboard, backups kept for 14 days.</p>
</section>
</body>
</html>`;

// ─── scrape_webpage ──────────────────────────────────────────────────────────

const SCRAPE_URLS = [
  'https://vercel.com/pricing',
  'https://render.com/pricing',
  'https://fly.io/docs/about/pricing/',
] as const;

const SCRAPE_OUTPUT = JSON.stringify(
  {
    total: 3,
    successful: 2,
    failed: 1,
    results: [
      {
        url: SCRAPE_URLS[0],
        success: true,
        title: 'Vercel Pricing: Hobby, Pro, and Enterprise plans',
        content:
          '# Find a plan to power your apps\n\n## Hobby\n\n**$0** forever. For personal projects.\n\n## Pro\n\n**$20/mo** per member. Includes $20 of usage credit.\n\n- 1 TB fast data transfer\n- 10M edge requests\n\n## Enterprise\n\nCustom pricing. SSO, SLA, and a dedicated success manager.',
        content_length: 247,
        metadata: { title: 'Vercel Pricing: Hobby, Pro, and Enterprise plans', statusCode: 200 },
      },
      {
        url: SCRAPE_URLS[1],
        success: true,
        title: 'Pricing | Render',
        content:
          '# Pricing\n\n## Workspace plans\n\n| Plan | Price | Team members |\n| --- | --- | --- |\n| Hobby | $0 | 1 |\n| Professional | $19 per user/month | up to 10 |\n| Organization | $29 per user/month | unlimited |\n\n## Postgres\n\nBasic-256mb starts at **$6/month**. Point-in-time recovery on Pro instances and above.',
        content_length: 296,
        metadata: { title: 'Pricing | Render', statusCode: 200 },
      },
      {
        url: SCRAPE_URLS[2],
        success: false,
        error: 'Request timed out after 30000ms. The page may block automated access.',
      },
    ],
  },
  null,
  2,
);

// ─── image_search ────────────────────────────────────────────────────────────

const IMAGE_SEARCH_QUERY = 'saas pricing page three tier cards';

const IMAGE_SEARCH_OUTPUT = JSON.stringify(
  {
    query: IMAGE_SEARCH_QUERY,
    total: 6,
    images: [
      {
        url: 'https://images.fixture.invalid/dribbble/saas-pricing-page.png',
        title: 'SaaS pricing page – three tiers',
        source: 'https://dribbble.com/shots/23810442-SaaS-Pricing-Page',
        width: 1600,
        height: 1200,
      },
      {
        url: 'https://images.fixture.invalid/dribbble/pricing-cards.png',
        title: 'Pricing cards with annual toggle',
        source: 'https://dribbble.com/shots/22950127-Pricing-Cards',
        width: 1600,
        height: 1200,
      },
      {
        url: 'https://images.fixture.invalid/webflow/pricing-hero.webp',
        title: 'Webflow template pricing section',
        source: 'https://webflow.com/templates/html/saas-pricing-website-template',
        width: 1280,
        height: 960,
      },
      {
        url: 'https://images.fixture.invalid/behance/dashboard-pricing-ui-kit.png',
        title: 'Dashboard pricing UI kit',
        source: 'https://www.behance.net/gallery/171203911/Dashboard-Pricing-UI-Kit',
        width: 1400,
        height: 1050,
      },
      {
        url: 'https://images.fixture.invalid/tailwindui/pricing-three-tiers.png',
        title: 'Three tiers – Tailwind UI pricing sections',
        source: 'https://tailwindui.com/components/marketing/sections/pricing',
        width: 1440,
        height: 900,
      },
      {
        url: 'https://images.fixture.invalid/saasframe/pricing-comparison-table.png',
        title: 'Plan comparison table',
        source: 'https://www.saasframe.io/categories/pricing-page',
        width: 1200,
        height: 900,
      },
    ],
  },
  null,
  2,
);

// ─── image_gen / video_gen / presentation_gen ────────────────────────────────

const IMAGE_GEN_OUTPUT = JSON.stringify({
  success: true,
  action: 'generate',
  path: '/workspace/acme-dashboard/public/og/pricing.png',
  width: 1200,
  height: 630,
  model: 'black-forest-labs/flux-1.1-pro',
});

const VIDEO_GEN_OUTPUT = JSON.stringify({
  success: true,
  path: '/workspace/acme-dashboard/public/media/pricing-toggle.mp4',
  duration_seconds: 6,
  resolution: '1280x720',
  model: 'google/veo-3-fast',
});

const PRESENTATION_OUTPUT = JSON.stringify({
  success: true,
  action: 'create_slide',
  presentation_name: 'acme-pricing-review',
  presentation_path: '/workspace/presentations/acme-pricing-review',
  slide_number: 3,
  slide_title: 'One billing sync at a time',
  slide_file: 'presentations/acme-pricing-review/slide_03.html',
  total_slides: 5,
  message: 'Slide 3 created',
});

// ─── memory ──────────────────────────────────────────────────────────────────

const MEMORY_STACK_PATH = '.kortix/memory/acme-dashboard/stack.md';
const MEMORY_LOCKS_PATH = '.kortix/memory/acme-dashboard/advisory-locks.md';

const MEMORY_VIEW_DIR_OUTPUT = [
  "Here're the files and directories up to 2 levels deep in .kortix/memory, excluding hidden items and node_modules:",
  '8.0K\t.kortix/memory',
  '4.0K\t.kortix/memory/acme-dashboard',
  '1.1K\t.kortix/memory/acme-dashboard/stack.md',
  '912\t.kortix/memory/acme-dashboard/pricing.md',
  '640\t.kortix/memory/preferences.md',
].join('\n');

const MEMORY_STACK_MD = `# acme-dashboard stack

- **Runtime:** Node 22, TypeScript 5.9, Next.js 16 App Router
- **Database:** Postgres 16 behind PgBouncer in transaction pooling mode
- **Jobs:** \`billing-sync\` runs every 5 minutes on 3 replicas

## Known issues

- Duplicate Stripe invoice items when two replicas run \`billing-sync\` at once`;

const MEMORY_VIEW_FILE_OUTPUT = [
  `Content of ${MEMORY_STACK_PATH} with line numbers:`,
  ...MEMORY_STACK_MD.split('\n').map((line, i) => `${i + 1}\t${line}`),
].join('\n');

const MEMORY_LOCKS_MD = `# Advisory locks in acme-dashboard

Decision: \`billing-sync\` takes a **transaction-level** lock.

\`\`\`ts
await client.query('BEGIN');
const { rows } = await client.query(
  'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok',
  ['billing-sync'],
);
if (!rows[0].ok) return client.query('ROLLBACK');
\`\`\`

## Why not session locks

- PgBouncer runs in transaction mode, so a session lock can outlive the job
- A session lock taken twice needs two unlocks`;

// ─── memory search ───────────────────────────────────────────────────────────

const MEMORY_SEARCH_OUTPUT = JSON.stringify({
  query: 'billing sync duplicate invoice',
  source: 'all',
  total: 3,
  results: [
    {
      id: '1204',
      type: 'decision',
      source: 'ltm',
      confidence: 0.88,
      content:
        'billing-sync must be single-flight: wrap it in pg_try_advisory_xact_lock(hashtext(\'billing-sync\')) because PgBouncer runs in transaction mode.',
      files: ['apps/api/src/jobs/billing-sync.ts'],
    },
    {
      id: '517',
      type: 'bugfix',
      source: 'obs',
      confidence: 0.74,
      content:
        'Two replicas ran billing-sync in the same minute on 2026-09-02 and created 41 duplicate Stripe invoice items.',
      files: ['apps/api/src/jobs/billing-sync.ts', 'apps/api/src/lib/stripe.ts'],
    },
    {
      id: '1188',
      type: 'preference',
      source: 'ltm',
      confidence: 0.52,
      content: 'Jay prefers idempotency keys on every Stripe write, even behind a lock.',
      files: [],
    },
  ],
});

const LTM_SEARCH_OUTPUT = `=== LTM Search: "pricing page tiers" (2 results) ===
[LTM/fact] #1211 (confidence: 0.83)
  acme-dashboard sells three tiers: Starter $0, Team $29 per seat, Business $79 per seat. Annual billing takes 20% off.
  Files: apps/web/src/app/pricing/page.tsx, apps/web/src/lib/plans.ts
[obs/insight] #533 (confidence: 0.61)
  The Business tier card hides the SSO row below 640px, so mobile visitors never see the main upgrade reason.`;

// ─── get_mem ─────────────────────────────────────────────────────────────────

const GET_MEM_OBSERVATION_OUTPUT = `=== Observation #517 [bugfix] ===
Title: Duplicate invoice items from concurrent billing-sync
Narrative:
Two replicas started billing-sync in the same minute and both wrote invoice items for 41 accounts. The job had no lock and Stripe writes had no idempotency key.
Tool: bash | Prompt #9
Session: ses_4Qm2hXbT8wVn
Created: 2026-09-02
Facts:
- 41 accounts received duplicate invoice items
- billing-sync runs on 3 replicas every 5 minutes
Concepts: postgres, advisory-locks, billing, concurrency
Files read: apps/api/src/jobs/billing-sync.ts, apps/api/src/lib/stripe.ts`;

const GET_MEM_LTM_OUTPUT = `=== LTM #1204 [decision] ===
Caption: billing-sync is single-flight through a transaction-level advisory lock
Content:
Wrap billing-sync in pg_try_advisory_xact_lock(hashtext('billing-sync')). Session-level locks are not safe because PgBouncer runs in transaction pooling mode, and a pooled connection can carry a lock into the next checkout.
Session: ses_7Hc1pRzK3dLe
Created: 2026-09-03 | Updated: 2026-09-16
Tags: postgres, advisory-locks, billing, pgbouncer`;

// ─── DCP ─────────────────────────────────────────────────────────────────────

const CONTEXT_INFO_OUTPUT = `## Context usage

**112,480 / 200,000 tokens (56%)**

| Segment | Tokens |
| --- | ---: |
| System prompt | 9,812 |
| Tool definitions | 14,236 |
| Conversation | 31,904 |
| Tool outputs | 56,528 |

Prunable tool outputs: 7 calls, 38,140 tokens (ids 4, 7, 9, 10, 12, 13, 15).`;

const COMPRESS_OUTPUT = `Compressed 9 messages about "advisory lock research" into a 3-sentence summary:

Postgres advisory locks give acme-dashboard a named lock with no table row. PgBouncer runs in transaction pooling mode, so billing-sync must use pg_try_advisory_xact_lock and exit when it returns false. Stripe writes keep idempotency keys as a second guard.`;

const DISTILL_OUTPUT = `Distilled 3 tool outputs (18,420 tokens → 1,210 tokens):

- **#12 webfetch** functions-admin.html: the four advisory lock functions and when each releases.
- **#13 scrape_webpage**: Vercel Pro $20 per member, Render Professional $19 per user; fly.io timed out.
- **#15 web_search**: session locks leak through pooled connections; use transaction-level locks.`;

const PRUNE_OUTPUT = `Pruned 4 tool outputs (19,720 tokens freed):

- #4 read apps/api/src/jobs/billing-sync.ts (superseded by a later read)
- #7 bash pnpm test --filter api (stale output)
- #9 image_search saas pricing page three tier cards
- #10 webfetch https://supabase.com/pricing`;

// ─── Group ───────────────────────────────────────────────────────────────────

export const WEB_MEMORY_TOOL_GROUP: FixtureToolGroup = {
  key: 'web-memory',
  prompt:
    'Our billing-sync job double-charged customers again. Research Postgres advisory locks for acme-dashboard, compare competitor pricing pages, save what you learn to memory, and draft a slide for Friday.',
  reasoning:
    'The duplicates come from three replicas running billing-sync at once, so I need the exact advisory lock semantics under PgBouncer transaction pooling. I will check memory for earlier decisions first, then confirm the lock functions in the Postgres docs. The pricing research can run in parallel through search and scraping.',
  summary:
    'billing-sync now needs `pg_try_advisory_xact_lock(hashtext(\'billing-sync\'))`: session locks leak through PgBouncer transaction pooling. I saved the decision to `.kortix/memory/acme-dashboard/advisory-locks.md` and recorded the incident in `stack.md`. Vercel Pro costs $20 per member and Render Professional $19 per user; the fly.io page timed out. Slide 3 of `acme-pricing-review` is ready, and a 1200×630 pricing OG image is at `public/og/pricing.png`.',
  specs: [
    // ── web_search ──
    {
      renderer: 'web-search-tool.tsx',
      tool: 'web_search',
      input: { query: `${SEARCH_Q1} ||| ${SEARCH_Q2}`, num_results: 5, search_depth: 'basic' },
      output: WEB_SEARCH_OUTPUT,
      error: 'TimeoutError: The operation was aborted due to timeout',
      durationMs: 3400,
      note: 'Batch mode: 2 queries (4 + 3 sources). Both surfaces read `results[].query` + `results[].results[].{title,url}` through `@kortix/sdk` `parseWebSearchOutput`. The running row shows the raw `a ||| b` input query; the completed row says "2 searches".',
    },
    {
      renderer: 'web-search-tool.tsx',
      tool: 'web_search',
      input: { query: 'acme-dashboard competitor pricing 2026' },
      output: WEB_SEARCH_PAYMENT_FAILURE_OUTPUT,
      error: 'Payment Required: Insufficient credits',
      durationMs: 420,
      states: ['completed'],
      note: 'Embedded failure: completed state, `{success:false,error}` output. `detectEmbeddedFailure` (sdk classify.ts) marks the tool view `error`; `isErrorOutput` routes the body to `ToolOutputFallback` → `JsonFailureOutputCard` on both surfaces.',
    },
    // ── webfetch ──
    {
      renderer: 'web-fetch-tool.tsx',
      tool: 'webfetch',
      input: { url: FETCH_MD_URL, format: 'markdown' },
      output: WEB_FETCH_MARKDOWN_OUTPUT,
      title: `${FETCH_MD_URL} (text/html; charset=utf-8)`,
      error: 'Request failed with status code: 404',
      durationMs: 900,
      note: 'Markdown format: not HTML, so both surfaces render the body through `ToolOutputFallback` as markdown (under the 4000-char raw-block threshold). The trigger is the domain plus a `markdown` arg.',
    },
    {
      renderer: 'web-fetch-tool.tsx',
      tool: 'web_fetch',
      input: { url: FETCH_HTML_URL, format: 'html' },
      output: WEB_FETCH_HTML_OUTPUT,
      title: `${FETCH_HTML_URL} (text/html; charset=utf-8)`,
      error: 'Request failed with status code: 403',
      durationMs: 1100,
      note: 'HTML format: the readable branch. Web `extractReadableHtml` (tool-renderers-sanitization.ts) and mobile `extractReadableHtml` (lib/session/tools/web-fetch.ts) take the `<title>` as the trigger title, decode `&amp;`, drop `<style>`/`<script>`, and show "View raw HTML".',
    },
    // ── scrape_webpage ──
    {
      renderer: 'scrape-webpage-tool.tsx',
      tool: 'scrape_webpage',
      input: { urls: SCRAPE_URLS.join(',') },
      output: SCRAPE_OUTPUT,
      error: 'TimeoutError: The operation was aborted due to timeout',
      durationMs: 6200,
      note: 'Three URLs, one failed: `partOutcome` answers `partial`. Both surfaces call `@kortix/sdk` `resolveScrapeResults`; the failed row shows the destructive glyph and its `error` as content. `urls` is the comma-separated string the starter tool takes.',
    },
    // ── image_search ──
    {
      renderer: 'image-search-tool.tsx',
      tool: 'image_search',
      input: { query: IMAGE_SEARCH_QUERY, num_results: 6 },
      output: IMAGE_SEARCH_OUTPUT,
      error: 'Error: Serper API returned 429: {"message":"Too many requests"}',
      durationMs: 1500,
      note: 'Single-query shape `{query,total,images:[{url,title,source,width,height}]}`. Both surfaces filter tile URLs through `safeHttpUrl` (http/https only), so `data:` URIs are dropped and https URLs are required. Tile URLs use the reserved `.invalid` TLD (RFC 6761): no image request leaves the device, and both surfaces draw their failed-tile state (web hides the `<img>`, mobile sets `failed`).',
    },
    // ── image_gen ──
    {
      renderer: 'image-gen-tool.tsx',
      tool: 'image_gen',
      input: {
        action: 'generate',
        prompt:
          'Minimal Open Graph image for a SaaS pricing page: three tier cards on a soft gray grid, no text',
        aspect_ratio: '1.91:1',
      },
      output: IMAGE_GEN_OUTPUT,
      error: 'Error: Replicate prediction failed: model returned no output',
      durationMs: 8400,
      note: 'Sandbox path only, no `url`. Web loads it with `useFileContent` (base64 → blob URL; the path text shows when the fetch fails). Mobile loads it with `useSandboxImage` (probe → load / tap-to-load). A `url` diverges: web uses it as `<img src>` unchecked (a `data:` URI renders), mobile requires `safeHttpUrl`.',
    },
    // ── video_gen ──
    {
      renderer: 'video-gen-tool.tsx',
      tool: 'video_gen',
      input: {
        prompt:
          'Six-second loop: a pricing toggle switches from monthly to annual and the three prices count down',
        duration: 6,
        aspect_ratio: '16:9',
      },
      output: VIDEO_GEN_OUTPUT,
      error: 'Error: Video generation timed out after 300s',
      durationMs: 42000,
      note: 'Divergence: web prints the output JSON in an `OutputBlock` only. Mobile also runs `parseVideoOutput` (`path` / `video_path` / `output_path`, `url` / `video_url` / `replicate_url`) and draws a `VideoPosterCard` with an Open button above the block.',
    },
    // ── presentation_gen ──
    {
      renderer: 'presentation-gen-tool.tsx',
      tool: 'presentation_gen',
      input: {
        action: 'create_slide',
        presentation_name: 'acme-pricing-review',
        slide_number: 3,
        slide_title: 'One billing sync at a time',
        content:
          '<section class="slide"><h1>One billing sync at a time</h1><ul><li>3 replicas, 1 lock</li><li>pg_try_advisory_xact_lock</li><li>0 duplicate invoices since 2026-09-16</li></ul></section>',
      },
      output: PRESENTATION_OUTPUT,
      error: "Error: Presentation 'acme-pricing-review' has no slide 2. Create slides in order.",
      durationMs: 700,
      note: 'create_slide: success line "Created slide 3: …", "(5 total)", "5 slides" trigger badge, and the `slide_file` line on both surfaces. No `viewer_url`: the preview/serve actions probe that URL (web `useSandboxProxy` + `InlineServicePreview`, mobile `useServicePreview`).',
    },
    // ── memory ──
    {
      renderer: 'memory-tool.tsx',
      tool: 'memory',
      input: { command: 'view', path: '.kortix/memory' },
      output: MEMORY_VIEW_DIR_OUTPUT,
      error: 'Error: The path .kortix/memory does not exist. Please provide a valid path.',
      durationMs: 150,
      note: 'view of a directory: `parseMemoryView` "files and directories" branch → size + name rows, the root line skipped. Title "Memory read", no subtitle (the root relativises to `memory`).',
    },
    {
      renderer: 'memory-tool.tsx',
      tool: 'memory',
      input: { command: 'view', path: MEMORY_STACK_PATH },
      output: MEMORY_VIEW_FILE_OUTPUT,
      error: `Error: The path ${MEMORY_STACK_PATH} does not exist. Please provide a valid path.`,
      durationMs: 140,
      note: 'view of a `.md` file: "with line numbers" branch strips the `N\\t` prefixes and renders a markdown card.',
    },
    {
      renderer: 'memory-tool.tsx',
      tool: 'memory',
      input: { command: 'create', path: MEMORY_LOCKS_PATH, file_text: MEMORY_LOCKS_MD },
      output: `File created successfully at: ${MEMORY_LOCKS_PATH}`,
      error: `Error: File already exists at: ${MEMORY_LOCKS_PATH}. Cannot overwrite files using command \`create\`.`,
      durationMs: 180,
      note: 'create: the body is `input.file_text` as a markdown card; title "Memory updated", subtitle `acme-dashboard/advisory-locks.md`.',
    },
    {
      renderer: 'memory-tool.tsx',
      tool: 'memory',
      input: {
        command: 'str_replace',
        path: MEMORY_STACK_PATH,
        old_str:
          '- Duplicate Stripe invoice items when two replicas run `billing-sync` at once',
        new_str:
          '- Fixed 2026-09-16: `billing-sync` takes `pg_try_advisory_xact_lock` (see advisory-locks.md)',
      },
      output: 'The memory file has been edited successfully.',
      error: `Error: No replacement was performed, old_str \`- Duplicate invoices\` did not appear verbatim in ${MEMORY_STACK_PATH}.`,
      durationMs: 160,
      note: 'str_replace: inline diff from `old_str` / `new_str`.',
    },
    // ── memory search ──
    {
      renderer: 'memory-search-tool.tsx',
      tool: 'memory_search',
      input: { query: 'billing sync duplicate invoice', source: 'all' },
      output: MEMORY_SEARCH_OUTPUT,
      error: 'Error: memory index is not ready. Retry in a few seconds.',
      durationMs: 380,
      note: 'JSON shape: 3 hits across `ltm` and `obs`, with confidence and file chips. Title "Memory Search". Web parses with `lib/utils/memory-search-output.ts`; mobile with its port `lib/session/tools/projects-memory-search-output.ts`.',
    },
    {
      renderer: 'memory-search-tool.tsx',
      tool: 'ltm_search',
      input: { query: 'pricing page tiers' },
      output: LTM_SEARCH_OUTPUT,
      error: 'Error: memory index is not ready. Retry in a few seconds.',
      durationMs: 300,
      note: 'Text shape: `=== LTM Search: "…" (N results) ===` header plus `[LTM|obs/type] #id (confidence: n)` blocks. The label contains "LTM", so the title is "LTM Search".',
    },
    // ── get_mem ──
    {
      renderer: 'get-mem-tool.tsx',
      tool: 'get_mem',
      input: { source: 'obs', id: 517 },
      output: GET_MEM_OBSERVATION_OUTPUT,
      error: 'Error: Observation #517 not found',
      durationMs: 120,
      note: 'Observation report: title in the subtitle, `#517` badge, narrative, facts, concepts, tool/prompt/session, files read. Known parser defect on BOTH surfaces (web `parseMemoryEntryOutput` and the mobile port): `compactField` flattens newlines, so the two `- ` facts collapse into one fact string.',
    },
    {
      renderer: 'get-mem-tool.tsx',
      tool: 'get_mem',
      input: { source: 'ltm', id: 1204 },
      output: GET_MEM_LTM_OUTPUT,
      error: 'Error: LTM entry #1204 not found',
      durationMs: 110,
      note: 'LTM entry: caption, content, tags, session, and the `Updated:` split out of the `Created:` field.',
    },
    // ── DCP ──
    {
      renderer: 'context-info-tool.tsx',
      tool: 'context_info',
      input: {},
      output: CONTEXT_INFO_OUTPUT,
      error: 'Error: DCP state is not available for this session',
      durationMs: 60,
      note: 'Token breakdown rendered as markdown through `ToolOutputFallback`. The renderer returns null without output (pending/running/error). `shouldShowToolPart` (sdk parts.ts `HIDDEN_TOOLS`) hides `context_info` from the chat turn on both surfaces (web session-chat.tsx, mobile SessionTurn.tsx / turn-body.ts); only a direct renderer mount shows it.',
    },
    {
      renderer: 'dcp-compress-tool.tsx',
      tool: 'compress',
      input: {
        topic: 'advisory lock research',
        content: {
          startString: 'Research Postgres advisory locks for acme-dashboard',
          endString: 'use transaction-level locks.',
          summary:
            'billing-sync must use pg_try_advisory_xact_lock under PgBouncer transaction pooling.',
        },
      },
      output: COMPRESS_OUTPUT,
      error: 'Error: startString was not found in the conversation',
      durationMs: 240,
    },
    {
      renderer: 'dcp-distill-tool.tsx',
      tool: 'distill',
      input: {
        ids: ['12', '13', '15'],
        distillation: [
          'Four advisory lock functions; xact variants release at transaction end.',
          'Vercel Pro $20/member, Render Professional $19/user, fly.io timed out.',
          'Session locks leak through pooled connections.',
        ],
      },
      output: DISTILL_OUTPUT,
      error: 'Error: Unknown tool ids: 15',
      durationMs: 200,
      note: 'The trigger shows "3 tools" on both surfaces (web `ids.length` + i18n `tools`, mobile `dcpIdsLabel`).',
    },
    {
      renderer: 'dcp-prune-tool.tsx',
      tool: 'prune',
      input: { ids: ['4', '7', '9', '10'], reason: 'noise' },
      output: PRUNE_OUTPUT,
      error: 'Error: Unknown tool ids: 10',
      durationMs: 90,
      note: 'The trigger shows the `reason` and "4 tools". `narration.ts` hides compress/distill/prune/context_info from the Easy panel only.',
    },
  ],
};
