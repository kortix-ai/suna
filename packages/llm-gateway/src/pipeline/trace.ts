import type { GatewayHooks, GatewayLogger, GatewayTrace, TokenCounts } from '../domain';

const EMPTY_USAGE: TokenCounts = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
};

export type TraceFields = Partial<GatewayTrace> & { status: number; ok: boolean };

/**
 * Emits one trace. `mark` records when the request reached a pipeline point,
 * so the trace can split its latency: `metadata.timing.prep_ms` is admission,
 * routing and resolution up to the upstream call; `upstream_response_ms` is
 * the wait for the upstream's response headers — for a stream, its first byte.
 * `admit_ms`, `route_ms`, `resolve_ms` and `billing_ms` split `prep_ms` into
 * the host hooks that run before dispatch (authorize, resolveRoute,
 * resolveUpstream, assertBillingActive).
 * Measured on dev-api 2026-09-27, a managed call's total latency could not be
 * attributed to either side without them.
 */
export type TracePoint = 'admitted' | 'routed' | 'resolved' | 'billed' | 'dispatch' | 'upstream_response';

export type TraceEmitter = ((fields: TraceFields) => void) & {
  mark: (point: TracePoint) => void;
};

function logTrace(logger: GatewayLogger, trace: GatewayTrace): void {
  const model = trace.resolvedModel || trace.requestedModel || 'unknown';
  const tokens = trace.usage.promptTokens + trace.usage.completionTokens;
  const tried = trace.candidatesTried.length > 1 ? ` tried=${trace.candidatesTried.join(',')}` : '';
  const upstream = trace.upstream ? ` upstream=${trace.upstream.provider}:${trace.upstream.model}` : '';
  const timing = trace.metadata.timing as Record<string, number | undefined> | undefined;
  const split = timing
    ? ` prep=${timing.prep_ms ?? '-'}ms upstream_response=${timing.upstream_response_ms ?? '-'}ms` +
      ` (admit=${timing.admit_ms ?? '-'} route=${timing.route_ms ?? '-'} resolve=${timing.resolve_ms ?? '-'} billing=${timing.billing_ms ?? '-'})`
    : '';

  if (trace.ok) {
    logger.info(
      `[gateway] ✓ ${trace.requestId} ${model} via ${trace.provider} ${trace.status} ${trace.latencyMs}ms${split} ${tokens}tok $${trace.finalCost.toFixed(5)}${tried}${upstream}`,
    );
    return;
  }

  const reason = trace.errorMessage ? ` "${String(trace.errorMessage).slice(0, 200)}"` : '';
  logger.warn(
    `[gateway] ✗ ${trace.requestId} ${model} ${trace.status} ${trace.errorCode ?? 'error'}${reason} ${trace.latencyMs}ms${split}${tried}${upstream}`,
  );
}

export function createTraceEmitter(
  hooks: GatewayHooks,
  logger: GatewayLogger,
  requestId: string,
  startedAt: string,
  startMs: number,
): TraceEmitter {
  const marks: Partial<Record<TracePoint, number>> = {};
  const between = (from: number | undefined, to: number | undefined) =>
    from !== undefined && to !== undefined ? to - from : undefined;
  const timing = (): Record<string, number> | null => {
    if (marks.dispatch === undefined) return null;
    const segments: Record<string, number | undefined> = {
      prep_ms: marks.dispatch - startMs,
      upstream_response_ms: between(marks.dispatch, marks.upstream_response),
      admit_ms: between(startMs, marks.admitted),
      route_ms: between(marks.admitted, marks.routed),
      resolve_ms: between(marks.routed, marks.resolved),
      billing_ms: between(marks.resolved, marks.billed),
    };
    return Object.fromEntries(
      Object.entries(segments).filter((entry): entry is [string, number] => entry[1] !== undefined),
    );
  };
  const emit = ((fields) => {
    const split = timing();
    const trace: GatewayTrace = {
      requestId,
      startedAt,
      accountId: fields.accountId ?? '',
      actorUserId: fields.actorUserId ?? '',
      projectId: fields.projectId,
      sessionId: fields.sessionId,
      keyId: fields.keyId,
      requestedModel: fields.requestedModel ?? '',
      resolvedModel: fields.resolvedModel ?? fields.requestedModel ?? '',
      provider: fields.provider ?? '',
      billingMode: fields.billingMode ?? 'none',
      streaming: fields.streaming ?? false,
      status: fields.status,
      ok: fields.ok,
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
      latencyMs: Date.now() - startMs,
      attempts: fields.attempts ?? 0,
      candidatesTried: fields.candidatesTried ?? [],
      attemptFailures: fields.attemptFailures ?? [],
      upstream: fields.upstream,
      usage: fields.usage ?? EMPTY_USAGE,
      upstreamCost: fields.upstreamCost ?? 0,
      finalCost: fields.finalCost ?? 0,
      request: fields.request,
      response: fields.response,
      metadata: split ? { ...(fields.metadata ?? {}), timing: split } : (fields.metadata ?? {}),
    };

    logTrace(logger, trace);

    if (hooks.recordTrace) {
      // Log only the error MESSAGE, never the raw error: a DB driver error
      // (e.g. postgres-js) carries `.query` and `.parameters` — the entire LLM
      // request body — which we must not ship to the log transport on every
      // failed trace write.
      void hooks.recordTrace(trace).catch((err) =>
        logger.warn(
          `[gateway] recordTrace failed for ${requestId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }) as TraceEmitter;
  // First mark wins: a fallback chain's later attempts do not move the split.
  emit.mark = (point) => {
    marks[point] ??= Date.now();
  };
  return emit;
}
