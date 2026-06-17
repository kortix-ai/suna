import { Langfuse } from 'langfuse';
import type { GatewayTrace } from '@kortix/llm-gateway';

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
        status: t.status,
        errorCode: t.errorCode,
        attempts: t.attempts,
        candidatesTried: t.candidatesTried,
        upstreamCost: t.upstreamCost,
        finalCost: t.finalCost,
      },
    },
  };
}

export interface TraceSink {
  record: (trace: GatewayTrace) => Promise<void>;
  shutdown: () => Promise<void>;
}

export function createLangfuseSink(
  cfg: LangfuseConfig,
  logger: { warn: (...args: unknown[]) => void } = console,
): TraceSink {
  const client = new Langfuse({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.baseUrl,
  });

  return {
    record: async (trace) => {
      try {
        const { trace: traceBody, generation } = traceToLangfuse(trace);
        client.trace(traceBody).generation(generation);
      } catch (err) {
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
  };
}
