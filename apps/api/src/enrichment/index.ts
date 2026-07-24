/**
 * Domain enrichment: submit a domain, get a structured company profile written
 * into the project's memory.
 *
 * The HTTP surface only queues and reports; the pipeline runs in the worker,
 * which is started on the leader replica alongside the other singleton workers.
 */
import { supabaseAuth } from '../middleware/auth';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import { createEnrichmentRateLimitMiddleware, createEnrichmentRouter } from './routes/enrichment';

export const enrichmentApp = makeOpenApiApp<AppEnv>();

enrichmentApp.use('*', supabaseAuth);
// Only submissions are limited; reading a job status is cheap and is what a
// polling UI does constantly.
enrichmentApp.use('/domains', createEnrichmentRateLimitMiddleware());
enrichmentApp.route('/', createEnrichmentRouter());

export { startEnrichmentWorker, stopEnrichmentWorker } from './services/worker';
export type { CompanyProfile } from './schemas';
