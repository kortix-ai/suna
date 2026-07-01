import { Data, Effect, Stream } from 'effect';
import { HTTPException } from 'hono/http-exception';
import { getProjectSecretValue } from '../../projects/secrets';
import type { ActorContext } from '../../shared/actor-context';
import { recordUsageEvent } from '../../shared/usage-events';
import { runEffectOrThrow } from '../../effect/http';
import type { ModelConfig } from '../config/models';
import {
  calculateAnthropicCost,
  extractAnthropicUsage,
  proxyToAnthropic,
  type AnthropicUsage,
} from './anthropic';
import { checkCredits, deductLLMCredits } from './billing';
import { calculateCost, extractUsage, getModel, proxyToOpenRouter, type UsageInfo } from './llm';
import {
  applyActorSpend,
  dollarsToCents,
  getSandboxMemberCapStatusEffect,
} from './member-spend';

export type LlmRequestBody = Record<string, unknown> & {
  model: string;
  messages: unknown[];
};

export type LlmWorkflowResult =
  | { readonly kind: 'json'; readonly body: unknown }
  | { readonly kind: 'stream'; readonly response: Response }
  | { readonly kind: 'upstream-error'; readonly response: Response };

export class LlmJsonParseError extends Data.TaggedError('LlmJsonParseError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class LlmValidationError extends Data.TaggedError('LlmValidationError')<{
  readonly message: string;
}> {}

export class LlmCreditCheckError extends Data.TaggedError('LlmCreditCheckError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class LlmInsufficientCreditsError extends Data.TaggedError('LlmInsufficientCreditsError')<{
  readonly message: string;
}> {}

export class LlmSpendCapError extends Data.TaggedError('LlmSpendCapError')<{
  readonly message: string;
}> {}

export class LlmProviderProxyError extends Data.TaggedError('LlmProviderProxyError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class LlmUpstreamBodyError extends Data.TaggedError('LlmUpstreamBodyError')<{
  readonly message: string;
}> {}

export class LlmProviderKeyLookupError extends Data.TaggedError('LlmProviderKeyLookupError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class LlmProviderKeyMissingError extends Data.TaggedError('LlmProviderKeyMissingError')<{
  readonly message: string;
}> {}

export class LlmBillingError extends Data.TaggedError('LlmBillingError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type JsonReader = () => Promise<unknown>;

type PublicOpenRouterInput = {
  readonly accountId: string;
  readonly readJson: JsonReader;
  readonly sessionId?: string;
  readonly actor?: ActorContext | null;
  readonly traceHeaders: Record<string, string>;
};

type AnthropicInput = {
  readonly accountId: string;
  readonly readJson: JsonReader;
  readonly actor?: ActorContext | null;
  readonly traceHeaders: Record<string, string>;
};

type SessionOpenRouterInput = {
  readonly accountId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly actorUserId: string;
  readonly readJson: JsonReader;
  readonly traceHeaders: Record<string, string>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function* readableBytes(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

const byteStream = (stream: ReadableStream<Uint8Array>, label: string) =>
  Stream.fromAsyncIterable(
    readableBytes(stream),
    (cause) =>
      new LlmBillingError({
        message: `${label} stream read failed: ${errorMessage(cause)}`,
        cause,
      }),
  );

const parseLlmBodyEffect = (readJson: JsonReader) =>
  Effect.tryPromise({
    try: readJson,
    catch: (cause) =>
      new LlmJsonParseError({
        message: 'Invalid JSON body',
        cause,
      }),
  }).pipe(Effect.flatMap(validateLlmBodyEffect));

const validateLlmBodyEffect = (body: unknown) =>
  Effect.suspend(() => {
    const record =
      body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};

    if (typeof record.model !== 'string' || record.model.length === 0) {
      return Effect.fail(
        new LlmValidationError({ message: 'Validation error: model is required' }),
      );
    }

    if (!Array.isArray(record.messages) || record.messages.length === 0) {
      return Effect.fail(
        new LlmValidationError({
          message: 'Validation error: messages is required and must be a non-empty array',
        }),
      );
    }

    return Effect.succeed(record as LlmRequestBody);
  });

const ensureCreditsEffect = (accountId: string) =>
  Effect.tryPromise({
    try: () => checkCredits(accountId),
    catch: (cause) =>
      new LlmCreditCheckError({
        message: `Credit check failed: ${errorMessage(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((creditCheck) =>
      creditCheck.hasCredits
        ? Effect.succeed(creditCheck)
        : Effect.fail(
            new LlmInsufficientCreditsError({
              message: creditCheck.message || 'Insufficient credits',
            }),
          ),
    ),
  );

const ensureMemberCapEffect = (
  actor: ActorContext | null | undefined,
  cycleLabel: 'month' | 'cycle',
) =>
  actor
    ? getSandboxMemberCapStatusEffect(actor.sandboxId, actor.userId).pipe(
        Effect.mapError(
          (cause) =>
            new LlmCreditCheckError({
              message: `Credit check failed: ${errorMessage(cause)}`,
              cause,
            }),
        ),
        Effect.flatMap((status) => {
          if (status && status.capCents !== null && status.currentCents >= status.capCents) {
            return Effect.fail(
              new LlmSpendCapError({
                message: `Spending cap reached ($${(status.capCents / 100).toFixed(2)} / ${cycleLabel}). Ask the instance owner to raise or remove the cap.`,
              }),
            );
          }
          return Effect.void;
        }),
      )
    : Effect.void;

const proxyOpenRouterEffect = (
  body: LlmRequestBody,
  isStreaming: boolean,
  apiKey: string | undefined,
  traceHeaders: Record<string, string>,
) =>
  Effect.tryPromise({
    try: () => proxyToOpenRouter(body, isStreaming, apiKey, traceHeaders),
    catch: (cause) =>
      new LlmProviderProxyError({
        message: `OpenRouter proxy failed: ${errorMessage(cause)}`,
        cause,
      }),
  });

const proxyAnthropicEffect = (
  body: LlmRequestBody,
  isStreaming: boolean,
  traceHeaders: Record<string, string>,
) =>
  Effect.tryPromise({
    try: () => proxyToAnthropic(body, isStreaming, traceHeaders),
    catch: (cause) =>
      new LlmProviderProxyError({
        message: `Anthropic proxy failed: ${errorMessage(cause)}`,
        cause,
      }),
  });

const upstreamErrorResultEffect = (
  response: Response,
  options?: { readonly logPrefix?: string; readonly providerName?: string },
) =>
  Effect.tryPromise({
    try: async () => {
      const errorBody = await response.text();
      if (options?.logPrefix) {
        const label = options.providerName
          ? `${options.logPrefix} ${options.providerName} error`
          : `${options.logPrefix} Error`;
        console.error(`${label} ${response.status}: ${errorBody}`);
      }
      return {
        kind: 'upstream-error',
        response: new Response(errorBody, {
          status: response.status,
          headers: {
            'Content-Type': response.headers.get('Content-Type') || 'application/json',
          },
        }),
      } satisfies LlmWorkflowResult;
    },
    catch: (cause) =>
      new LlmProviderProxyError({
        message: `Failed to read upstream error response: ${errorMessage(cause)}`,
        cause,
      }),
  });

const upstreamJsonEffect = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      new LlmProviderProxyError({
        message: `Failed to read upstream JSON response: ${errorMessage(cause)}`,
        cause,
      }),
  });

const streamResponseEffect = (
  response: Response,
  onBillingStream: (stream: ReadableStream<Uint8Array>) => void,
) =>
  Effect.suspend(() => {
    const upstreamBody = response.body;
    if (!upstreamBody) {
      return Effect.fail(new LlmUpstreamBodyError({ message: 'No response body from upstream' }));
    }

    const [clientStream, billingStream] = upstreamBody.tee();
    onBillingStream(billingStream);

    return Effect.succeed({
      kind: 'stream',
      response: new Response(clientStream, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      }),
    } satisfies LlmWorkflowResult);
  });

const scheduleOpenAiBillingEffect = (input: {
  readonly accountId: string;
  readonly modelId: string;
  readonly modelConfig: ModelConfig;
  readonly responseBody: unknown;
  readonly sessionId?: string;
  readonly actor?: ActorContext | null;
}) =>
  Effect.sync(() => {
    const usage = extractUsage(input.responseBody);
    if (!usage) return;

    const cost = calculateCost(
      input.modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
    );

    deductLLMCredits(
      input.accountId,
      input.modelId,
      usage.promptTokens,
      usage.completionTokens,
      cost,
      input.sessionId,
    )
      .then((res) => {
        if (res.success && input.actor && cost > 0) {
          applyActorSpend(
            input.actor.sandboxId,
            input.actor.userId,
            dollarsToCents(cost),
          ).catch((err) => console.error('[LLM] Actor spend attribution failed:', err));
        }
      })
      .catch((err) => console.error(`[LLM] Failed to deduct credits for ${input.modelId}:`, err));

    const cacheInfo =
      usage.cachedTokens || usage.cacheWriteTokens
        ? ` (cache: ${usage.cachedTokens}read/${usage.cacheWriteTokens}write)`
        : '';
    console.log(
      `[LLM] ${input.modelId}: ${usage.promptTokens}/${usage.completionTokens} tokens${cacheInfo}, cost=$${cost.toFixed(6)}`,
    );
  });

const scheduleAnthropicBillingEffect = (input: {
  readonly accountId: string;
  readonly modelId: string;
  readonly modelConfig: ModelConfig;
  readonly responseBody: unknown;
  readonly sessionId?: string;
  readonly actor?: ActorContext | null;
}) =>
  Effect.sync(() => {
    const usage = extractAnthropicUsage(input.responseBody);
    if (!usage) return;

    const cost = calculateAnthropicCost(input.modelConfig, usage);
    deductLLMCredits(
      input.accountId,
      input.modelId,
      usage.inputTokens,
      usage.outputTokens,
      cost,
      input.sessionId,
    )
      .then((res) => {
        if (res.success && input.actor && cost > 0) {
          applyActorSpend(
            input.actor.sandboxId,
            input.actor.userId,
            dollarsToCents(cost),
          ).catch((err) =>
            console.error('[LLM][Anthropic] Actor spend attribution failed:', err),
          );
        }
      })
      .catch((err) =>
        console.error(`[LLM][Anthropic] Failed to deduct credits for ${input.modelId}:`, err),
      );

    console.log(
      `[LLM][Anthropic] ${input.modelId}: ${usage.inputTokens}in/${usage.outputTokens}out ` +
        `(cache: ${usage.cacheReadInputTokens}read/${usage.cacheCreationInputTokens}write), ` +
        `cost=$${cost.toFixed(6)}`,
    );
  });

const scheduleSessionBillingEffect = (input: {
  readonly accountId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly actorUserId: string;
  readonly modelId: string;
  readonly modelConfig: ModelConfig;
  readonly responseBody: unknown;
  readonly upstreamStatus: number;
}) =>
  Effect.sync(() => {
    const usage = extractUsage(input.responseBody);
    if (!usage) return;

    const cost = calculateCost(
      input.modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
    );

    deductLLMCredits(
      input.accountId,
      input.modelId,
      usage.promptTokens,
      usage.completionTokens,
      cost,
      input.sessionId,
    ).catch((err) => console.error('[session-llm] Failed to deduct credits:', err));

    recordUsageEvent({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      provider: 'openrouter',
      model: input.modelId,
      route: '/v1/router/llm/chat/completions',
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: cost,
      streaming: false,
      upstreamStatus: input.upstreamStatus,
    }).catch((err) => console.error('[session-llm] Failed to record usage event:', err));
  });

const extractOpenAiStreamUsageEffect = (
  stream: ReadableStream<Uint8Array>,
  input: {
    readonly accountId: string;
    readonly modelId: string;
    readonly modelConfig: ModelConfig;
    readonly sessionId?: string;
    readonly actor?: ActorContext | null;
  },
) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    let buffer = '';
    const lastUsage: { current: UsageInfo | null } = { current: null };

    yield* byteStream(stream, 'OpenAI billing').pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            if (chunk.usage) {
              const details = chunk.usage.prompt_tokens_details;
              lastUsage.current = {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                cachedTokens: details?.cached_tokens ?? 0,
                cacheWriteTokens: details?.cache_write_tokens ?? 0,
              };
            }
          } catch {
          }
        }
        }),
      ),
    );

    const usage = lastUsage.current;
    if (!usage) {
      console.warn(`[LLM] Stream ${input.modelId}: no usage data found in stream — billing skipped`);
      return;
    }

    const cost = calculateCost(
      input.modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
    );
    const deductRes = yield* Effect.tryPromise({
      try: () => deductLLMCredits(
        input.accountId,
        input.modelId,
        usage.promptTokens,
        usage.completionTokens,
        cost,
        input.sessionId,
      ),
      catch: (cause) =>
        new LlmBillingError({
          message: `OpenAI stream billing failed: ${errorMessage(cause)}`,
          cause,
        }),
    });
    if (deductRes.success && input.actor && cost > 0) {
      applyActorSpend(input.actor.sandboxId, input.actor.userId, dollarsToCents(cost)).catch(
        (err) => console.error('[LLM] Actor spend attribution failed:', err),
      );
    }
    const cacheInfo =
      usage.cachedTokens || usage.cacheWriteTokens
        ? ` (cache: ${usage.cachedTokens}read/${usage.cacheWriteTokens}write)`
        : '';
    console.log(
      `[LLM] Stream ${input.modelId}: ${usage.promptTokens}/${usage.completionTokens} tokens${cacheInfo}, cost=$${cost.toFixed(6)}`,
    );
  });

const extractAnthropicStreamUsageEffect = (
  stream: ReadableStream<Uint8Array>,
  input: {
    readonly accountId: string;
    readonly modelId: string;
    readonly modelConfig: ModelConfig;
    readonly sessionId?: string;
    readonly actor?: ActorContext | null;
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationInputTokens = 0;
      let cacheReadInputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'message_start' && data.message?.usage) {
              inputTokens = data.message.usage.input_tokens ?? 0;
              cacheCreationInputTokens = data.message.usage.cache_creation_input_tokens ?? 0;
              cacheReadInputTokens = data.message.usage.cache_read_input_tokens ?? 0;
            }

            if (data.type === 'message_delta' && data.usage) {
              outputTokens = data.usage.output_tokens ?? 0;
            }
          } catch {
          }
        }
      }

      if (!(inputTokens > 0 || outputTokens > 0)) {
        console.warn(
          `[LLM][Anthropic] Stream ${input.modelId}: no usage data found — billing skipped`,
        );
        return;
      }

      const usage: AnthropicUsage = {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
      };
      const cost = calculateAnthropicCost(input.modelConfig, usage);
      const deductRes = await deductLLMCredits(
        input.accountId,
        input.modelId,
        inputTokens,
        outputTokens,
        cost,
        input.sessionId,
      );
      if (deductRes.success && input.actor && cost > 0) {
        applyActorSpend(input.actor.sandboxId, input.actor.userId, dollarsToCents(cost)).catch(
          (err) => console.error('[LLM][Anthropic] Actor spend attribution failed:', err),
        );
      }
      console.log(
        `[LLM][Anthropic] Stream ${input.modelId}: ${inputTokens}in/${outputTokens}out ` +
          `(cache: ${cacheReadInputTokens}read/${cacheCreationInputTokens}write), ` +
          `cost=$${cost.toFixed(6)}`,
      );
    },
    catch: (cause) =>
      new LlmBillingError({
        message: `Anthropic stream billing failed: ${errorMessage(cause)}`,
        cause,
      }),
  });

const extractSessionStreamUsageEffect = (
  stream: ReadableStream<Uint8Array>,
  input: {
    readonly accountId: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly actorUserId: string;
    readonly modelId: string;
    readonly modelConfig: ModelConfig;
    readonly upstreamStatus: number;
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastUsage: UsageInfo | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            if (chunk.usage) {
              const details = chunk.usage.prompt_tokens_details;
              lastUsage = {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                cachedTokens: details?.cached_tokens ?? 0,
                cacheWriteTokens: details?.cache_write_tokens ?? 0,
              };
            }
          } catch {
          }
        }
      }

      if (!lastUsage) {
        console.warn(`[session-llm] Stream ${input.modelId}: no usage data found`);
        return;
      }

      const cost = calculateCost(
        input.modelConfig,
        lastUsage.promptTokens,
        lastUsage.completionTokens,
        lastUsage.cachedTokens,
        lastUsage.cacheWriteTokens,
      );
      await deductLLMCredits(
        input.accountId,
        input.modelId,
        lastUsage.promptTokens,
        lastUsage.completionTokens,
        cost,
        input.sessionId,
      );
      await recordUsageEvent({
        accountId: input.accountId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        provider: 'openrouter',
        model: input.modelId,
        route: '/v1/router/llm/chat/completions',
        inputTokens: lastUsage.promptTokens,
        outputTokens: lastUsage.completionTokens,
        cachedTokens: lastUsage.cachedTokens,
        cacheWriteTokens: lastUsage.cacheWriteTokens,
        costUsd: cost,
        streaming: true,
        upstreamStatus: input.upstreamStatus,
      });
    },
    catch: (cause) =>
      new LlmBillingError({
        message: `Session LLM stream billing failed: ${errorMessage(cause)}`,
        cause,
      }),
  });

const runBackgroundBilling = (
  effect: Effect.Effect<void, LlmBillingError>,
  logMessage: string,
) => {
  void Effect.runPromise(
    effect.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error(logMessage, error.cause);
        }),
      ),
    ),
  );
};

const resolveSessionOpenRouterKeyEffect = (projectId: string) =>
  Effect.tryPromise({
    try: async () =>
      (await getProjectSecretValue(projectId, 'OPENROUTER_API_KEY')) ??
      process.env.OPENROUTER_API_KEY ??
      null,
    catch: (cause) =>
      new LlmProviderKeyLookupError({
        message: `OPENROUTER_API_KEY lookup failed: ${errorMessage(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((apiKey) =>
      apiKey
        ? Effect.succeed(apiKey)
        : Effect.fail(
            new LlmProviderKeyMissingError({
              message: 'OPENROUTER_API_KEY project secret is not configured',
            }),
          ),
    ),
  );

export const openRouterLlmWorkflowEffect = (input: PublicOpenRouterInput) =>
  Effect.gen(function* () {
    const body = yield* parseLlmBodyEffect(input.readJson);
    const modelId = body.model;
    const isStreaming = body.stream === true;
    const sessionId =
      (typeof body.session_id === 'string' ? body.session_id : undefined) ?? input.sessionId;

    yield* ensureMemberCapEffect(input.actor, 'month');
    yield* ensureCreditsEffect(input.accountId);

    const modelConfig = getModel(modelId);
    const response = yield* proxyOpenRouterEffect(
      body,
      isStreaming,
      undefined,
      input.traceHeaders,
    );

    if (!response.ok) {
      return yield* upstreamErrorResultEffect(response, {
        logPrefix: '[LLM]',
        providerName: 'OpenRouter',
      });
    }

    if (isStreaming) {
      return yield* streamResponseEffect(response, (billingStream) =>
        runBackgroundBilling(
          extractOpenAiStreamUsageEffect(billingStream, {
            accountId: input.accountId,
            modelId,
            modelConfig,
            sessionId,
            actor: input.actor,
          }),
          '[LLM] Error extracting usage from stream for billing:',
        ),
      );
    }

    const responseBody = yield* upstreamJsonEffect(response);
    yield* scheduleOpenAiBillingEffect({
      accountId: input.accountId,
      modelId,
      modelConfig,
      responseBody,
      sessionId,
      actor: input.actor,
    });

    return { kind: 'json', body: responseBody } satisfies LlmWorkflowResult;
  });

export const anthropicLlmWorkflowEffect = (input: AnthropicInput) =>
  Effect.gen(function* () {
    const body = yield* parseLlmBodyEffect(input.readJson);
    const modelId = body.model;
    const isStreaming = body.stream === true;
    const metadata = body.metadata as Record<string, unknown> | undefined;
    const sessionId =
      typeof metadata?.session_id === 'string' ? metadata.session_id : undefined;

    yield* ensureMemberCapEffect(input.actor, 'cycle');
    yield* ensureCreditsEffect(input.accountId);

    const modelConfig = getModel(modelId);
    const response = yield* proxyAnthropicEffect(body, isStreaming, input.traceHeaders);

    if (!response.ok) {
      return yield* upstreamErrorResultEffect(response, {
        logPrefix: '[LLM][Anthropic]',
      });
    }

    if (isStreaming) {
      return yield* streamResponseEffect(response, (billingStream) =>
        runBackgroundBilling(
          extractAnthropicStreamUsageEffect(billingStream, {
            accountId: input.accountId,
            modelId,
            modelConfig,
            sessionId,
            actor: input.actor,
          }),
          '[LLM][Anthropic] Error extracting usage from stream:',
        ),
      );
    }

    const responseBody = yield* upstreamJsonEffect(response);
    yield* scheduleAnthropicBillingEffect({
      accountId: input.accountId,
      modelId,
      modelConfig,
      responseBody,
      sessionId,
      actor: input.actor,
    });

    return { kind: 'json', body: responseBody } satisfies LlmWorkflowResult;
  });

export const sessionOpenRouterLlmWorkflowEffect = (input: SessionOpenRouterInput) =>
  Effect.gen(function* () {
    const body = yield* parseLlmBodyEffect(input.readJson);
    const modelId = body.model;
    const isStreaming = body.stream === true;

    yield* ensureCreditsEffect(input.accountId);

    const apiKey = yield* resolveSessionOpenRouterKeyEffect(input.projectId);
    const modelConfig = getModel(modelId);
    const response = yield* proxyOpenRouterEffect(
      body,
      isStreaming,
      apiKey,
      input.traceHeaders,
    );

    if (!response.ok) {
      return yield* upstreamErrorResultEffect(response);
    }

    if (isStreaming) {
      return yield* streamResponseEffect(response, (usageStream) =>
        runBackgroundBilling(
          extractSessionStreamUsageEffect(usageStream, {
            accountId: input.accountId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            actorUserId: input.actorUserId,
            modelId,
            modelConfig,
            upstreamStatus: response.status,
          }),
          '[session-llm] Failed to extract streaming usage:',
        ),
      );
    }

    const responseBody = yield* upstreamJsonEffect(response);
    yield* scheduleSessionBillingEffect({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      modelId,
      modelConfig,
      responseBody,
      upstreamStatus: response.status,
    });

    return { kind: 'json', body: responseBody } satisfies LlmWorkflowResult;
  });

export const runOpenRouterLlmWorkflow = (input: PublicOpenRouterInput) =>
  runEffectOrThrow(openRouterLlmWorkflowEffect(input));

export const runAnthropicLlmWorkflow = (input: AnthropicInput) =>
  runEffectOrThrow(anthropicLlmWorkflowEffect(input));

export const runSessionOpenRouterLlmWorkflow = (input: SessionOpenRouterInput) =>
  runEffectOrThrow(sessionOpenRouterLlmWorkflowEffect(input));

export function throwLlmWorkflowHttp(error: unknown): never {
  if (error instanceof HTTPException) {
    throw error;
  }

  if (error instanceof LlmJsonParseError || error instanceof LlmValidationError) {
    throw new HTTPException(400, { message: error.message });
  }

  if (error instanceof LlmInsufficientCreditsError || error instanceof LlmSpendCapError) {
    throw new HTTPException(402, { message: error.message });
  }

  if (error instanceof LlmProviderKeyMissingError) {
    throw new HTTPException(503, { message: error.message });
  }

  if (error instanceof LlmUpstreamBodyError) {
    throw new HTTPException(502, { message: error.message });
  }

  if (
    error instanceof LlmCreditCheckError ||
    error instanceof LlmProviderProxyError ||
    error instanceof LlmProviderKeyLookupError
  ) {
    throw new HTTPException(500, { message: error.message });
  }

  throw error;
}
