import type { GatewayTrace } from '@kortix/llm-gateway';
import { Langfuse } from 'langfuse';

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}

type TraceBody = NonNullable<Parameters<Langfuse['trace']>[0]>;
type GenerationBody = Parameters<ReturnType<Langfuse['trace']>['generation']>[0];

export interface TracePayloads {
  trace: TraceBody;
  generation: GenerationBody;
}

function nonEmpty(...values: (string | undefined)[]): string[] {
  return values.filter((v): v is string => Boolean(v));
}

export function traceToLangfuse(t: GatewayTrace): TracePayloads {
  const startedAt = new Date(t.startedAt);
  const endedAt = new Date(startedAt.getTime() + t.latencyMs);
  const totalTokens = t.usage.promptTokens + t.usage.completionTokens;
  const attemptFailures = t.attemptFailures ?? [];
  const failureMetadata = {
    attemptFailures,
    failureCount: attemptFailures.length,
    failureCodes: attemptFailures.map((failure) => String(failure.code)),
    fallbackRecovered: t.ok && attemptFailures.length > 0,
  };

  return {
    trace: {
      id: t.requestId,
      name: 'chat.completion',
      userId: t.actorUserId || undefined,
      sessionId: t.projectId || t.accountId || undefined,
      input: t.request,
      output: t.response,
      timestamp: startedAt,
      tags: nonEmpty(t.provider, t.billingMode, t.streaming ? 'streaming' : undefined),
      metadata: {
        accountId: t.accountId,
        projectId: t.projectId,
        keyId: t.keyId,
        billingMode: t.billingMode,
        provider: t.provider,
        ...(t.upstream ? { upstreamProvider: t.upstream.provider, upstreamModel: t.upstream.model } : {}),
        streaming: t.streaming,
        status: t.status,
        ok: t.ok,
        latencyMs: t.latencyMs,
        attempts: t.attempts,
        candidatesTried: t.candidatesTried,
        upstreamCost: t.upstreamCost,
        finalCost: t.finalCost,
        errorCode: t.errorCode,
        errorMessage: t.errorMessage,
        ...failureMetadata,
      },
    },
    generation: {
      name: 'llm',
      model: t.resolvedModel || t.requestedModel,
      input: t.request,
      output: t.response,
      startTime: startedAt,
      endTime: endedAt,
      usageDetails: {
        input: t.usage.promptTokens,
        output: t.usage.completionTokens,
        cache_read_input_tokens: t.usage.cachedTokens,
        total: totalTokens,
      },
      costDetails: {
        total: t.finalCost,
      },
      level: t.ok ? 'DEFAULT' : 'ERROR',
      statusMessage: t.errorMessage,
      metadata: {
        requestedModel: t.requestedModel,
        provider: t.provider,
        ...(t.upstream ? { upstreamProvider: t.upstream.provider, upstreamModel: t.upstream.model } : {}),
        status: t.status,
        errorCode: t.errorCode,
        attempts: t.attempts,
        candidatesTried: t.candidatesTried,
        upstreamCost: t.upstreamCost,
        finalCost: t.finalCost,
        ...failureMetadata,
      },
    },
  };
}

/**
 * A trace that never reaches Langfuse fails INSIDE `record()`'s own try/catch
 * (below) and is only ever surfaced as a `logger.warn` line — and gateway logs
 * are not shipped anywhere queryable today (no Better Stack source, CloudWatch
 * needs MFA). PROD 2026-09-24T17:35Z: Langfuse Cloud stopped receiving traces
 * platform-wide and nothing noticed for ~2.5 days, because nothing outside the
 * warn log ever changed. This is the fact `/health` needs to make that kind of
 * failure visible within one health-check interval instead of a manual census.
 */
export interface TraceSinkStatus {
  /** Epoch ms of the last trace this sink queued into the client without throwing. */
  lastQueuedAt: number | null;
  /** Epoch ms of the last time `record()` threw. */
  lastFailureAt: number | null;
  lastError: string | null;
  /** Resets to 0 on any success; a sustained outage is a rising streak, not one blip. */
  consecutiveFailures: number;
}

export interface TraceSink {
  record: (trace: GatewayTrace) => Promise<void>;
  shutdown: () => Promise<void>;
  status: () => TraceSinkStatus;
}

export function createLangfuseSink(
  cfg: LangfuseConfig,
  logger: { warn: (...args: unknown[]) => void } = console,
): TraceSink {
  const client = new Langfuse({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.baseUrl,
    // Batch. `record()` used to await `flushAsync()` per request, which is one
    // HTTP POST per trace with no concurrency cap and up to ~24s of internal
    // retries — during a Langfuse outage that accumulates one in-flight fetch
    // per request on the gateway. Observability must never be able to push
    // back on the serving path.
    flushAt: 50,
    flushInterval: 5_000,
  });

  const state: TraceSinkStatus = {
    lastQueuedAt: null,
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
  };

  return {
    record: async (trace) => {
      try {
        const { trace: traceBody, generation } = traceToLangfuse(trace);
        client.trace(traceBody).generation(generation);
        // No flush here: the client batches and the shutdown hook drains. This
        // only proves the trace was handed to the SDK's in-memory queue, not
        // that Langfuse ingested it — the SDK flushes/retries in the
        // background and has no per-item delivery callback to await instead.
        state.lastQueuedAt = Date.now();
        state.consecutiveFailures = 0;
      } catch (err) {
        state.lastFailureAt = Date.now();
        state.lastError = err instanceof Error ? err.message : String(err);
        state.consecutiveFailures += 1;
        logger.warn('[gateway] failed to record trace to langfuse', err);
      }
    },
    shutdown: async () => {
      try {
        await client.flushAsync();
        await client.shutdownAsync();
      } catch (err) {
        logger.warn('[gateway] langfuse shutdown failed', err);
      }
    },
    status: () => ({ ...state }),
  };
}
