// Domain enrichment — turn a company's public website into a structured
// profile in the project's memory. Submitting is asynchronous by design: the
// crawl and extraction take minutes, so `enrichDomain` returns a job to poll
// rather than a profile.
//
// Most callers never need this module: passing `domain` to `provisionProject`
// queues the same work at creation time. Use these when a domain arrives after
// the project exists — the onboarding wizard, or re-running a stale profile.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type EnrichmentJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead_lettered';

/** Why a job stopped. `internal_error` is ours, not the site's. */
export type EnrichmentErrorCode =
  | 'invalid_domain'
  | 'blocked'
  | 'timeout'
  | 'extraction_failed'
  | 'internal_error';

export interface EnrichmentJob {
  jobId: string;
  domain: string;
  status: EnrichmentJobStatus;
  errorCode: EnrichmentErrorCode | null;
  /** Present once the job finishes: where the profile landed and what it cost. */
  result: {
    domain?: string;
    memoryPath?: string;
    crawlStatus?: 'complete' | 'partial';
    pagesDiscovered?: number;
    pagesFetched?: number;
    cacheHit?: boolean;
  } | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface EnrichDomainInput {
  projectId: string;
  /** A bare domain or a full URL; the backend reduces it to an apex host. */
  domain: string;
  /** Re-crawl even when a fresh cached profile exists. */
  force?: boolean;
  account_id?: string;
}

/**
 * Queue an enrichment run for a project. Returns the job — a request for a
 * domain already being enriched for this project attaches to the in-flight job
 * instead of starting a second one.
 */
export async function enrichDomain(input: EnrichDomainInput): Promise<EnrichmentJob> {
  return unwrap(
    await backendApi.post<EnrichmentJob>('/enrichment/domains', {
      projectId: input.projectId,
      domain: input.domain,
      ...(input.force ? { force: true } : {}),
      ...(input.account_id ? { account_id: input.account_id } : {}),
    }),
  );
}

/** Read a job's current state. Poll this after {@link enrichDomain}. */
export async function getEnrichmentJob(jobId: string): Promise<EnrichmentJob> {
  return unwrap(await backendApi.get<EnrichmentJob>(`/enrichment/jobs/${jobId}`));
}

/** True once the job will not change again. */
export function isEnrichmentJobFinished(job: EnrichmentJob): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'dead_lettered';
}
