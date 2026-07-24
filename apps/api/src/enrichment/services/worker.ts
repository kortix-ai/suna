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
import { consolidate } from './consolidate';
import { discover } from './discovery';
import { extractProfile } from './extract';
import { withGatewayChat } from './gateway-chat';
import { fetchPages } from './page-fetch';
import { canonicalOrigin } from './normalize';
import { assertSafeUrl, boundedFetch } from './safe-fetch';
import { writeProfileToMemory, type MemoryPort } from './memory-write';
import { selectUrls, type UrlTier } from './url-filter';

const MAX_ATTEMPTS = 3;
const LEASE_MS = 6 * 60 * 1000;
const MAX_CONCURRENT_JOBS = 2;
const BACKOFF_MS = [60_000, 300_000];

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

export interface JobResult {
  domain: string;
  memoryPath: string;
  crawlStatus: CrawlStatus;
  pagesDiscovered: number;
  pagesFetched: number;
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
    // written into THIS project's memory, which is the part that is per-tenant.
    const memoryPath = await writeToMemory(deps, job, cached.profile, {
      domain,
      crawledAt: cached.crawledAt.toISOString(),
      crawlStatus: cached.crawlStatus,
      model: cached.model ?? model,
    });
    return {
      domain,
      memoryPath,
      crawlStatus: cached.crawlStatus,
      pagesDiscovered: 0,
      pagesFetched: 0,
      cacheHit: true,
    };
  }

  const discovery = await discover(origin, { signal, fetchImpl: deps.fetchImpl });
  const ranked = selectUrls(discovery.urls, origin);
  const tierByUrl = new Map<string, UrlTier>(ranked.map((r) => [r.url, r.tier]));

  const fetched = await fetchPages(
    ranked.map((r) => r.url),
    {
      jinaApiKey: config.JINA_API_KEY || undefined,
      firecrawlApiKey: config.FIRECRAWL_API_KEY || undefined,
      firecrawlApiUrl: config.FIRECRAWL_API_URL,
      rpm: config.KORTIX_ENRICHMENT_JINA_RPM,
      signal,
      cache: { get: getCachedPages, put: putCachedPage },
      fetchImpl: deps.fetchImpl,
      assertUrl: deps.assertUrl,
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

  const consolidated = consolidate(
    domain,
    fetched.pages.map((page) => ({
      url: page.url,
      markdown: page.markdown,
      tier: tierByUrl.get(page.url) ?? 'other',
    })),
    discovery.signals,
  );

  const { profile } = await deps.runChat(
    {
      accountId: job.accountId,
      userId: job.createdBy ?? job.accountId,
      projectId: job.projectId,
    },
    (chat) => extractProfile(consolidated.text, { chat, model, signal }),
  );

  await upsertProfile({ domain, profile, crawlStatus, model });

  const memoryPath = await writeToMemory(deps, job, profile, {
    domain,
    crawledAt: new Date().toISOString(),
    crawlStatus,
    model,
  });

  return {
    domain,
    memoryPath,
    crawlStatus,
    pagesDiscovered: ranked.length,
    pagesFetched: fetched.pages.length,
    cacheHit: false,
  };
}

async function writeToMemory(
  deps: EnrichmentJobDeps,
  job: EnrichmentJobRow,
  profile: CompanyProfile,
  provenance: { domain: string; crawledAt: string; crawlStatus: CrawlStatus; model: string },
): Promise<string> {
  const port = await deps.memoryPortFor(job.projectId);
  const { profilePath } = await writeProfileToMemory(port, {
    domain: provenance.domain,
    profile,
    provenance,
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
