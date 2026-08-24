import type { PlatinumJsonResponse } from '../../shared/platinum';

const MATERIALIZE_BUDGET_MS = 18_000;
const MATERIALIZE_MAX_ATTEMPTS = 4;
const MATERIALIZE_UNAVAILABLE_RETRY_MS = [250, 750, 1_500] as const;
const MATERIALIZE_FINAL_REQUEST_RESERVE_MS = 1_000;

type MaterializeBody = {
  status?: unknown;
  template_id?: unknown;
};

export type PlatinumMaterializeRequest = (
  path: string,
  init: RequestInit,
) => Promise<PlatinumJsonResponse<unknown>>;

export type PlatinumMaterializeResult = {
  status: 'disabled' | 'ready' | 'failed';
  attempts: number;
  elapsedMs: number;
  httpStatus: number | null;
  reason: string;
};

export type PlatinumMaterializeDependencies = {
  enabled: boolean;
  request: PlatinumMaterializeRequest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function statusFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/platinum\s+\S+\s+\S+\s+->\s+(\d{3})(?:\s|$)/i);
  return match ? Number(match[1]) : null;
}

function logResult(externalId: string, result: PlatinumMaterializeResult): void {
  const line =
    `[snapshots] platinum materialize ${externalId}: ${result.status} ` +
    `reason=${result.reason} attempts=${result.attempts} ` +
    `elapsed_ms=${result.elapsedMs} http_status=${result.httpStatus ?? 'none'}`;
  if (result.status === 'ready') console.info(line);
  else console.warn(line);
}

/**
 * Materialize one exact immutable Platinum template before it becomes active.
 * Failure is always fail-open because this changes boot latency, not correctness.
 */
export async function materializePlatinumTemplate(
  externalId: string,
  deps: PlatinumMaterializeDependencies,
): Promise<PlatinumMaterializeResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  if (!deps.enabled) {
    return {
      status: 'disabled',
      attempts: 0,
      elapsedMs: 0,
      httpStatus: null,
      reason: 'feature_disabled',
    };
  }

  const finish = (
    status: 'ready' | 'failed',
    attempts: number,
    httpStatus: number | null,
    reason: string,
  ): PlatinumMaterializeResult => {
    const result = {
      status,
      attempts,
      elapsedMs: Math.max(0, now() - startedAt),
      httpStatus,
      reason,
    };
    logResult(externalId, result);
    return result;
  };

  const deadline = startedAt + MATERIALIZE_BUDGET_MS;
  let attempts = 0;
  let lastStatus: number | null = null;

  while (attempts < MATERIALIZE_MAX_ATTEMPTS && now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - now());
    try {
      const response = await deps.request(
        `/v1/templates/${encodeURIComponent(externalId)}/materialize`,
        {
          method: 'POST',
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(remainingMs),
        },
      );
      lastStatus = response.status;
      const body = response.body as MaterializeBody | null;
      if (
        response.status === 200 &&
        body !== null &&
        typeof body === 'object' &&
        body.status === 'ready' &&
        body.template_id === externalId
      ) {
        return finish('ready', attempts, response.status, 'materialized');
      }
      if (response.status !== 202) {
        return finish('failed', attempts, response.status, 'unexpected_response');
      }
    } catch (error) {
      lastStatus = statusFromError(error);
      if (lastStatus !== 503) {
        return finish('failed', attempts, lastStatus, 'request_failed');
      }
    }

    if (attempts >= MATERIALIZE_MAX_ATTEMPTS) break;
    const remainingAfterRequestMs = deadline - now();
    if (remainingAfterRequestMs <= 0) break;

    if (lastStatus === 202) {
      // A reused command returns 202 immediately. Spread the remaining probes
      // across the absolute budget instead of spending all four in 2.5 seconds.
      // Keep one second for the final HTTP request and its response parsing.
      if (remainingAfterRequestMs <= MATERIALIZE_FINAL_REQUEST_RESERVE_MS) {
        await sleep(remainingAfterRequestMs);
        break;
      }
      const remainingRequestSlots = MATERIALIZE_MAX_ATTEMPTS - attempts;
      const delayMs = Math.max(
        1,
        Math.floor(
          (remainingAfterRequestMs - MATERIALIZE_FINAL_REQUEST_RESERVE_MS)
          / remainingRequestSlots,
        ),
      );
      await sleep(delayMs);
      continue;
    }

    // 503 means no eligible host accepted work. Keep this path short so an
    // unavailable optimization cannot add the whole budget to session boot.
    await sleep(Math.min(
      MATERIALIZE_UNAVAILABLE_RETRY_MS[attempts - 1],
      remainingAfterRequestMs,
    ));
  }

  return finish('failed', attempts, lastStatus, now() >= deadline ? 'budget_exhausted' : 'attempts_exhausted');
}
