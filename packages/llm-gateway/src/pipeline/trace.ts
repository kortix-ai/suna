import type { GatewayHooks, GatewayLogger, GatewayTrace, TokenCounts } from '../domain';

const EMPTY_USAGE: TokenCounts = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

export type TraceFields = Partial<GatewayTrace> & { status: number; ok: boolean };

export type TraceEmitter = (fields: TraceFields) => void;

function logTrace(logger: GatewayLogger, trace: GatewayTrace): void {
  const model = trace.resolvedModel || trace.requestedModel || 'unknown';
  const tokens = trace.usage.promptTokens + trace.usage.completionTokens;
  const tried = trace.candidatesTried.length > 1 ? ` tried=${trace.candidatesTried.join(',')}` : '';

  if (trace.ok) {
    logger.info(
      `[gateway] ✓ ${trace.requestId} ${model} via ${trace.provider} ${trace.status} ${trace.latencyMs}ms ${tokens}tok $${trace.finalCost.toFixed(5)}${tried}`,
    );
    return;
  }

  const reason = trace.errorMessage ? ` "${String(trace.errorMessage).slice(0, 200)}"` : '';
  logger.warn(
    `[gateway] ✗ ${trace.requestId} ${model} ${trace.status} ${trace.errorCode ?? 'error'}${reason} ${trace.latencyMs}ms${tried}`,
  );
}

export function createTraceEmitter(
  hooks: GatewayHooks,
  logger: GatewayLogger,
  requestId: string,
  startedAt: string,
  startMs: number,
): TraceEmitter {
  return (fields) => {
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
      usage: fields.usage ?? EMPTY_USAGE,
      upstreamCost: fields.upstreamCost ?? 0,
      finalCost: fields.finalCost ?? 0,
      request: fields.request,
      response: fields.response,
      metadata: fields.metadata ?? {},
    };

    logTrace(logger, trace);

    if (hooks.recordTrace) {
      void hooks.recordTrace(trace).catch((err) =>
        logger.warn(`[gateway] recordTrace failed for ${requestId}:`, err),
      );
    }
  };
}
