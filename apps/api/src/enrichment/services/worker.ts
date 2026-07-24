/**
 * The enrichment worker — the only place the pipeline runs end to end.
 *
 * Shape follows the other singleton workers in this process: an interval tick
 * with a reentrancy guard, started only on the leader-elected replica. That
 * one detail is load-bearing beyond scheduling — because a single replica runs
 * enrichment, the process-local Jina rate limiter is effectively a
 * deployment-wide one.
 *
 * The failure taxonomy is the part worth reading. A failure is either
 * PERMANENT (the domain is invalid, the site refuses us, the model cannot
 * produce a valid profile) and recorded immediately with its typed code, or
 * TRANSIENT (network, upstream 5xx, a lost commit race) and released back to
 * the queue behind a backoff gate until the attempt budget runs out. Retrying
 * a permanent failure just burns the budget and the site's patience; recording
 * a transient one as final loses work that would have succeeded a minute later.
 */
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { EnrichmentError, isEnrichmentError, type EnrichmentErrorCode } from '../errors';
import { getCachedPages, putCachedPage } from '../repositories/page-cache';
import {
  claimDueJobs,
  completeJob,
  failJob,
  rescheduleJob,
  type EnrichmentJobRow,
} from '../repositories/jobs';
import { createProjectMemoryPort, loadProject } from '../repositories/memory-port';
import { getFreshProfile, upsertProfile } from '../repositories/profiles';
import type { CompanyProfile, CrawlStatus } from '../schemas';
import type { ConsolidatePage } from './consolidate';
import { discover } from './discovery';
import { extractProfileFromPages } from './extract';
import { withGatewayChat } from './gateway-chat';
import { fetchPages, type FetchedPage, type FetchPagesOptions } from './page-fetch';
import { canonicalOrigin } from './normalize';
import { assertSafeUrl, boundedFetch } from './safe-fetch';
import { writeProfileToMemory, type MemoryPageContent, type MemoryPort } from './memory-write';
import { classifyUrl, selectUrls, MAX_SELECTED_URLS, type UrlTier } from './url-filter';

const MAX_ATTEMPTS = 3;
const LEASE_MS = 6 * 60 * 1000;
const MAX_CONCURRENT_JOBS = 2;
const BACKOFF_MS = [60_000, 300_000];

/**
 * Blog posts get their own budget rather than competing with priority pages
 * in one shared cap — a blog-heavy site would otherwise crowd out /about and
 * /pricing, and a blog post fetched in full is usually richer material than
 * one more "other"-tier page.
 */
const MAX_BLOG_POSTS = 20;

type Timer = ReturnType<typeof setInterval>;
const g = globalThis as unknown as { __kortixEnrichmentTimer?: Timer | null };
let timer: Timer | null = null;
let running = false;

function intervalMs(): number {
  const raw = Number(process.env.KORTIX_ENRICHMENT_WORKER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

function isPermanent(code: EnrichmentErrorCode): boolean {
  return code === 'invalid_domain' || code === 'blocked' || code === 'extraction_failed';
}

/** How many fetched pages each vendor tier served this run. `cache` (the
 * per-URL page cache, distinct from the whole-profile cache) is deliberately
 * not counted here — those pages did not cost a vendor call this run. */
export interface FetchTierCounts {
  jina: number;
  firecrawl: number;
  direct: number;
}

export interface JobResult {
  domain: string;
  memoryPath: string;
  crawlStatus: CrawlStatus;
  pagesDiscovered: number;
  pagesFetched: number;
  blogPostsFetched: number;
  fetchTiers: FetchTierCounts;
  cacheHit: boolean;
}

/**
 * The three things a test must not really do: reach the network, call a model,
 * and push a git commit. They are injectable so tests can substitute them
 * directly. The alternative — `mock.module` on `node:dns`, the gateway and the
 * git layer — is process-wide in this suite and collides with the unit tests
 * that exercise those same modules for real.
 */
export interface EnrichmentJobDeps {
  assertUrl: typeof assertSafeUrl;
  fetchImpl: typeof boundedFetch;
  runChat: typeof withGatewayChat;
  memoryPortFor: (projectId: string) => Promise<MemoryPort>;
  /**
   * Rate-limit knobs threaded straight into `fetchPages`'s options. The RPM
   * limiter it drives is a process-global singleton with a real `setTimeout`
   * sleep, so a test that wants to avoid paying for that wall-clock wait
   * (rather than masking it with a longer suite timeout) overrides `rpm`/
   * `now`/`sleep` here instead of reaching into `page-fetch` directly. Absent
   * (the production default), `fetchPages` gets the real clock and the
   * configured RPM.
   */
  fetchOverrides?: Pick<FetchPagesOptions, 'rpm' | 'now' | 'sleep'>;
}

const defaultDeps: EnrichmentJobDeps = {
  assertUrl: assertSafeUrl,
  fetchImpl: boundedFetch,
  runChat: withGatewayChat,
  memoryPortFor: async (projectId) => {
    const project = await loadProject(projectId);
    if (!project) throw new EnrichmentError('internal_error', `project ${projectId} not found`);
    return createProjectMemoryPort(project);
  },
};

/**
 * Run one job to completion, or throw. Exported so the integration test can
 * drive a single job without waiting on the interval.
 */
export async function runEnrichmentJob(
  job: EnrichmentJobRow,
  overrides: Partial<EnrichmentJobDeps> = {},
): Promise<JobResult> {
  const deps: EnrichmentJobDeps = { ...defaultDeps, ...overrides };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.KORTIX_ENRICHMENT_JOB_TIMEOUT_MS);

  try {
    return await executePipeline(job, controller.signal, deps);
  } catch (err) {
    // Whatever surfaced, the deadline firing is the real cause and the one the
    // caller needs in order to decide about a retry.
    if (controller.signal.aborted) {
      throw new EnrichmentError('timeout', `job exceeded its time budget for ${job.domain}`);
    }
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}

async function executePipeline(
  job: EnrichmentJobRow,
  signal: AbortSignal,
  deps: EnrichmentJobDeps,
): Promise<JobResult> {
  const domain = job.domain;
  const origin = canonicalOrigin(domain);
  const force = (job.payload as { force?: boolean })?.force === true;
  const model = config.KORTIX_ENRICHMENT_MODEL;

  // The guard runs before anything else touches the network, and its rejection
  // means the input was never enrichable — not that we should try again later.
  try {
    await deps.assertUrl(origin);
  } catch (err) {
    throw new EnrichmentError(
      'invalid_domain',
      `domain is not safely reachable: ${(err as Error).message}`,
    );
  }

  const cached = force
    ? null
    : await getFreshProfile(domain, config.KORTIX_ENRICHMENT_PROFILE_TTL_DAYS);

  if (cached) {
    // Another org already paid for this crawl. The profile still has to be
    // written into THIS project's memory, which is the part that is
    // per-tenant — including whatever page/blog content is still recoverable
    // from the per-URL cache, not just the profile. There is no fresh crawl on
    // this path, so recovery is necessarily partial; the guarantee this holds
    // to is narrower than "as rich as a fresh crawl" — it never deletes a
    // page/blog file this project already has unless there is actual evidence
    // (a recovered page in that same category) to reconcile against.
    const { pages, blogPosts } = await recoverCachedPages(cached.profile);
    const memoryPath = await writeToMemory(
      deps,
      job,
      cached.profile,
      {
        domain,
        crawledAt: cached.crawledAt.toISOString(),
        crawlStatus: cached.crawlStatus,
        model: cached.model ?? model,
      },
      { pages, blogPosts },
    );
    return {
      domain,
      memoryPath,
      crawlStatus: cached.crawlStatus,
      pagesDiscovered: 0,
      pagesFetched: 0,
      blogPostsFetched: 0,
      fetchTiers: { jina: 0, firecrawl: 0, direct: 0 },
      cacheHit: true,
    };
  }

  const discovery = await discover(origin, { signal, fetchImpl: deps.fetchImpl });

  // Site pages and blog posts draw from separate budgets (see MAX_BLOG_POSTS
  // above), so `selectUrls` is called uncapped here and each tier is sliced to
  // its own budget below rather than letting one global cap ration them
  // against each other.
  const ranked = selectUrls(discovery.urls, origin, Infinity);
  const siteRanked = ranked.filter((r) => r.tier !== 'blog').slice(0, MAX_SELECTED_URLS);
  const blogRanked = ranked.filter((r) => r.tier === 'blog').slice(0, MAX_BLOG_POSTS);
  const selected = [...siteRanked, ...blogRanked];
  const tierByUrl = new Map<string, UrlTier>(selected.map((r) => [r.url, r.tier]));

  const fetched = await fetchPages(
    selected.map((r) => r.url),
    {
      jinaApiKey: config.JINA_API_KEY || undefined,
      firecrawlApiKey: config.FIRECRAWL_API_KEY || undefined,
      firecrawlApiUrl: config.FIRECRAWL_API_URL,
      rpm: config.KORTIX_ENRICHMENT_JINA_RPM,
      signal,
      cache: { get: getCachedPages, put: putCachedPage },
      fetchImpl: deps.fetchImpl,
      assertUrl: deps.assertUrl,
      ...deps.fetchOverrides,
    },
  );

  // Nothing readable and nothing structured means the site refused us. Anything
  // less than that is still worth extracting from — a harvested social link or
  // mailto is as much real signal as an OpenGraph tag when a personal site has
  // no schema.org markup at all.
  const hasSignals =
    discovery.signals.jsonLd.length > 0 ||
    Object.keys(discovery.signals.openGraph).length > 0 ||
    !!discovery.signals.title ||
    discovery.signals.socials.length > 0 ||
    discovery.signals.emails.length > 0 ||
    discovery.signals.phones.length > 0 ||
    discovery.signals.otherExternal.length > 0;
  if (fetched.pages.length === 0 && !hasSignals) {
    throw new EnrichmentError('blocked', `no readable content for ${domain}`);
  }

  const crawlStatus: CrawlStatus =
    discovery.status === 'blocked' || fetched.failures.length > 0 || fetched.pages.length === 0
      ? 'partial'
      : 'complete';

  // Split by the url-selection tier (blog vs everything else), not by
  // `page.tier` — that is the fetch tier (jina/firecrawl/direct/cache) that
  // served the page and says nothing about what kind of page it is.
  const pagesForExtraction: ConsolidatePage[] = [];
  const sitePages: MemoryPageContent[] = [];
  const blogPosts: MemoryPageContent[] = [];
  for (const page of fetched.pages) {
    const urlTier = tierByUrl.get(page.url) ?? 'other';
    pagesForExtraction.push({ url: page.url, markdown: page.markdown, tier: urlTier });
    const memoryEntry: MemoryPageContent = { url: page.url, markdown: page.markdown, tier: page.tier };
    if (urlTier === 'blog') blogPosts.push(memoryEntry);
    else sitePages.push(memoryEntry);
  }

  const { profile } = await deps.runChat(
    {
      accountId: job.accountId,
      userId: job.createdBy ?? job.accountId,
      projectId: job.projectId,
    },
    (chat) => extractProfileFromPages(domain, pagesForExtraction, discovery.signals, { chat, model, signal }),
  );

  await upsertProfile({ domain, profile, crawlStatus, model });

  // Zero fetched pages is not evidence the site actually has none of either
  // category — every selected URL can fail post-discovery (a DNS rebind
  // between the two, a vendor outage across all three fetch tiers) with the
  // site itself untouched. `writeProfileToMemory` reads a concrete `[]` as
  // "crawled and confirmed empty, delete the stale files" (see its header),
  // so that verdict is only safe when this run actually fetched something to
  // confirm it against; otherwise the existing files are left alone exactly
  // like a cache-hit run that recovered nothing (`recoverCachedPages`).
  const memoryContent =
    fetched.pages.length > 0
      ? { pages: sitePages, blogPosts }
      : { pages: undefined, blogPosts: undefined };

  const memoryPath = await writeToMemory(
    deps,
    job,
    profile,
    { domain, crawledAt: new Date().toISOString(), crawlStatus, model },
    memoryContent,
  );

  return {
    domain,
    memoryPath,
    crawlStatus,
    pagesDiscovered: selected.length,
    pagesFetched: fetched.pages.length,
    blogPostsFetched: blogPosts.length,
    fetchTiers: countFetchTiers(fetched.pages),
    cacheHit: false,
  };
}

/** Tallies which vendor tier served each fetched page, for the job result. */
function countFetchTiers(pages: FetchedPage[]): FetchTierCounts {
  const counts: FetchTierCounts = { jina: 0, firecrawl: 0, direct: 0 };
  for (const page of pages) {
    if (page.tier === 'jina' || page.tier === 'firecrawl' || page.tier === 'direct') {
      counts[page.tier] += 1;
    }
  }
  return counts;
}

/**
 * A cache hit means another org already paid for the crawl, so there is no
 * fresh page list to draw from — only a DB read against the per-URL page
 * cache, keyed by the URLs the cached profile itself cites (`sources` plus
 * each `blogPosts` entry's `url`). Any of those whose markdown has since been
 * pruned from the cache is silently absent from the result. `classifyUrl` (the
 * same per-URL classifier `selectUrls` uses) decides the pages/blog split
 * here, since there is no fresh `selectUrls` ranking to read a tier off on
 * this path.
 *
 * `pages` and `blogPosts` are decided independently, each defaulting to
 * `undefined` unless recovery actually produced an entry in that category.
 * The model citing zero blog URLs this round (a normal citation gap, not
 * confirmation the blog is gone) must not read the same as a fresh crawl that
 * confirmed there are no blog posts — `writeProfileToMemory` treats `[]` as
 * the latter and deletes every previously-written file in that category. A
 * shared "did anything come back at all" flag would still make that mistake
 * whenever the other category recovered something, so each category's
 * concrete-vs-undefined call is made on its own evidence only.
 */
async function recoverCachedPages(
  profile: CompanyProfile,
): Promise<{ pages?: MemoryPageContent[]; blogPosts?: MemoryPageContent[] }> {
  const candidateUrls = [...new Set([...profile.sources, ...profile.blogPosts.map((p) => p.url)])];
  if (candidateUrls.length === 0) return {};

  const cachedMarkdown = await getCachedPages(candidateUrls);
  if (cachedMarkdown.size === 0) return {};

  const pages: MemoryPageContent[] = [];
  const blogPosts: MemoryPageContent[] = [];
  // Iterate the candidate list, not the map: `getCachedPages` runs an unordered
  // `IN (…)` query, so the map's iteration order is whatever Postgres returned.
  // Building the folder from that order makes the committed files — and the
  // MEMORY.md index — differ between identical re-runs, which both flakes tests
  // and produces noisy no-op git diffs. `candidateUrls` is a stable deduped list.
  for (const url of candidateUrls) {
    const markdown = cachedMarkdown.get(url);
    if (markdown === undefined) continue;
    const bucket = classifyUrl(url).tier === 'blog' ? blogPosts : pages;
    bucket.push({ url, markdown, tier: 'cache' });
  }
  return {
    pages: pages.length > 0 ? pages : undefined,
    blogPosts: blogPosts.length > 0 ? blogPosts : undefined,
  };
}

async function writeToMemory(
  deps: EnrichmentJobDeps,
  job: EnrichmentJobRow,
  profile: CompanyProfile,
  provenance: { domain: string; crawledAt: string; crawlStatus: CrawlStatus; model: string },
  content: { pages?: MemoryPageContent[]; blogPosts?: MemoryPageContent[] },
): Promise<string> {
  const port = await deps.memoryPortFor(job.projectId);
  const { profilePath } = await writeProfileToMemory(port, {
    domain: provenance.domain,
    profile,
    provenance,
    pages: content.pages,
    blogPosts: content.blogPosts,
  });
  return profilePath;
}

/**
 * Decide whether a failed job is finished or gets another attempt.
 *
 * Permanent verdicts are recorded as-is. A timeout is given exactly one more
 * attempt, because the usual cause is a slow site rather than a broken one.
 * Everything else is transient and follows the attempt budget, after which it
 * is dead-lettered rather than retried forever.
 */
export async function handleJobFailure(job: EnrichmentJobRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const code: EnrichmentErrorCode = isEnrichmentError(err) ? err.code : 'internal_error';

  if (isEnrichmentError(err) && isPermanent(err.code)) {
    await failJob({ jobId: job.jobId, errorCode: err.code, message });
    return;
  }

  const budget = code === 'timeout' ? 2 : MAX_ATTEMPTS;
  if (job.attempts >= budget) {
    await failJob({
      jobId: job.jobId,
      errorCode: code,
      message,
      deadLettered: code !== 'timeout',
    });
    return;
  }

  const backoff = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)] ?? 300_000;
  await rescheduleJob({
    jobId: job.jobId,
    availableAt: new Date(Date.now() + backoff),
    message,
  });
}

export async function runEnrichmentTick(): Promise<{ processed: number }> {
  const jobs = await claimDueJobs({
    workerId: `enrichment-${process.pid}`,
    limit: MAX_CONCURRENT_JOBS,
    leaseMs: LEASE_MS,
  });
  if (jobs.length === 0) return { processed: 0 };

  await Promise.all(
    jobs.map(async (job) => {
      try {
        const result = await runEnrichmentJob(job);
        await completeJob(job.jobId, { ...result });
      } catch (err) {
        logger.error('[enrichment-worker] job failed', {
          jobId: job.jobId,
          domain: job.domain,
          error: err instanceof Error ? err.message : String(err),
        });
        // If even recording the failure fails, the lease will lapse and the
        // job comes back on a later tick — never silently abandoned.
        await handleJobFailure(job, err).catch((settleErr) => {
          logger.error('[enrichment-worker] failed to record job failure', {
            jobId: job.jobId,
            error: settleErr instanceof Error ? settleErr.message : String(settleErr),
          });
        });
      }
    }),
  );

  return { processed: jobs.length };
}

export function startEnrichmentWorker(): void {
  if (!config.KORTIX_ENRICHMENT_WORKER_ENABLED) return;
  if (g.__kortixEnrichmentTimer) clearInterval(g.__kortixEnrichmentTimer);
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runEnrichmentTick()
      .catch((err) =>
        logger.error('[enrichment-worker] tick failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs());
  g.__kortixEnrichmentTimer = timer;
}

export function stopEnrichmentWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (g.__kortixEnrichmentTimer) {
    clearInterval(g.__kortixEnrichmentTimer);
    g.__kortixEnrichmentTimer = null;
  }
}
