/**
 * The four terminal failure modes a job can report. They are persisted on
 * `enrichment_jobs.error_code` and surfaced verbatim by the status endpoint, so
 * the UI can explain a failure without parsing message strings.
 *
 *   invalid_domain     — unparseable/private/unresolvable input; never retried
 *   blocked            — the site refused us (challenge page, 403, nothing fetched)
 *   timeout            — the job exceeded its wall-clock budget
 *   extraction_failed  — the model never produced a schema-valid profile
 */
export type EnrichmentErrorCode =
  | 'invalid_domain'
  | 'blocked'
  | 'timeout'
  | 'extraction_failed';

export class EnrichmentError extends Error {
  constructor(
    readonly code: EnrichmentErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

export function isEnrichmentError(err: unknown): err is EnrichmentError {
  return err instanceof EnrichmentError;
}
