import { config } from '../../config';
import { publicGatewayBaseUrl } from '../../llm-gateway/public-url';
import {
  calculateCost,
  callUpstream,
  publicPayload,
  publicUpstreamError,
  shownModel,
  shownProvider,
  type AuthedPrincipal,
} from '@kortix/llm-gateway';
import { type GenerationConfig, clampGenerationConfig } from '@kortix/llm-catalog';
import { resolveCandidates } from '../../llm-gateway/resolution/resolve-candidates';
import { catalogModelForWireModel } from '../../llm-gateway/models/catalog-models';
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { isDatabaseError } from '../../shared/database-errors';
import { logger } from '../../lib/logger';
import {
  assertGatewayBudget,
  GatewayBudgetExceededError,
  persistGatewayTrace,
  recordGatewayUsage,
} from '../../llm-gateway/hooks';
import { workspaceIdParam } from '../../shared/route-params';

/**
 * The per-model error text POST /{projectId}/gateway/playground returns for
 * one of the requested models. `err.message` is safe to echo for a typed
 * failure (`resolveCandidates`/`callUpstream` throw with a caller-meaningful
 * reason), but `recordGatewayUsage`/`persistGatewayTrace` can reject with a
 * `DrizzleQueryError`/`PostgresError` whose message is the whole generated
 * SQL statement plus its bound parameters (KRTX-3422's catch-echo guard).
 * This catch sits inside `Promise.all`, outside the route's own try/catch, so
 * nothing here reached the global handler (`shared/http-errors.ts`) that
 * already answers an uncaught database error with a generic 500 — an
 * authenticated caller could turn a crafted `model` value that made the
 * write fail into an oracle for the usage/trace tables (KRTX-4400). Never
 * echo a database error's message; log it instead and answer generically,
 * same shape as every other guarded catch-all in this codebase.
 */
export function playgroundModelError(err: unknown, model: string): string {
  if (isDatabaseError(err)) {
    logger.error('[gateway-playground] model run failed with a database error', {
      model,
      error: err instanceof Error ? err.message.split('\n')[0] : String(err),
    });
    return 'Request failed';
  }
  return err instanceof Error ? err.message : 'Request failed';
}

export function registerGatewayPlaygroundRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/gateway/playground',
      tags: ['gateway'],
      summary: 'Run a prompt in the project LLM gateway playground',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                prompt: z.string().min(1).max(8000),
                models: z.array(z.string()).min(1).max(6),
                system: z.string().max(4000).optional(),
                // Per-model generation-parameter overrides for THIS run only —
                // never persisted. Same shape + same server-side capability
                // clamp as the persisted routing-policy config (see
                // clampGenerationConfig below); an unsupported/out-of-range
                // field for a given model is silently dropped, not rejected.
                generationConfig: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
              }),
            },
          },
        },
      },
      responses: { 200: json(z.any(), 'Playground results'), ...errors(400, 402, 404) },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        // The playground spends credits on real model calls: a write, gated on
        // the leaf that changes the project's models, not on a spend READ.
        PROJECT_ACTIONS.PROJECT_MODEL_WRITE,
      );

      const body = await c.req.json();
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      const models: string[] = Array.isArray(body.models) ? body.models.slice(0, 6) : [];
      const system = typeof body.system === 'string' && body.system.trim() ? body.system : undefined;
      const rawGenerationConfig =
        body.generationConfig && typeof body.generationConfig === 'object'
          ? (body.generationConfig as Record<string, unknown>)
          : {};
      if (!prompt || models.length === 0) {
        return c.json({ error: 'prompt and models are required' }, 400);
      }

      const principal: AuthedPrincipal = {
        userId: c.get('userId'),
        accountId: loaded.row.accountId,
        projectId,
      };
      try {
        await assertGatewayBudget(principal);
      } catch (err) {
        if (!(err instanceof GatewayBudgetExceededError)) throw err;
        return c.json({ error: err.message, code: 'budget_exceeded' }, 402);
      }

      const results = await Promise.all(
        models.map(async (model) => {
          const requestId = crypto.randomUUID();
          // Same capability clamp the persisted routing-policy write path
          // uses — a playground run must never send a param the resolved
          // model can't honor either. Applied on top of the 512-token
          // default so an explicit override can raise (or lower) it.
          const clamped = clampGenerationConfig(
            rawGenerationConfig[model] as GenerationConfig | undefined,
            catalogModelForWireModel(model),
          );
          const request: Record<string, unknown> = {
            model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              { role: 'user', content: prompt },
            ],
            stream: false,
            max_tokens: clamped.maxOutputTokens ?? 512,
            ...(clamped.temperature !== undefined ? { temperature: clamped.temperature } : {}),
            ...(clamped.topP !== undefined ? { top_p: clamped.topP } : {}),
            ...(clamped.reasoningEffort !== undefined
              ? { reasoning_effort: clamped.reasoningEffort }
              : {}),
          };
          try {
            const candidates = await resolveCandidates(principal, model);
            if (candidates.length === 0) {
              return { model, ok: false, error: 'No upstream configured for this model' };
            }
            const descriptor = candidates[0]!;
            const start = Date.now();
            const res = await callUpstream(request, descriptor).catch(() => null);
            const tried = [shownProvider(descriptor)];
            if (!res) throw new Error('Request failed');
            const latencyMs = Date.now() - start;
            const rawData = (await res.json().catch(() => null)) as any;
            // A managed model reports Kortix, its own id, and a classified error.
            const publicError =
              descriptor.publicProvider && !res.ok
                ? publicUpstreamError(res.status, JSON.stringify(rawData ?? {}), model)
                : null;
            const data =
              descriptor.publicProvider && rawData && typeof rawData === 'object'
                ? (publicPayload(rawData, model) as any)
                : rawData;
            const usage = data?.usage ?? {};
            const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
            const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
            const cachedTokens =
              Number(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
            const cacheWriteTokens =
              Number(
                usage.cache_write_tokens ?? usage.prompt_tokens_details?.cache_write_tokens ?? 0,
              ) || 0;
            const resolvedModel = descriptor.publicProvider
              ? shownModel(descriptor, model)
              : String(data?.model ?? descriptor.resolvedModel ?? model);
            const { upstreamCost, finalCost } = calculateCost(
              descriptor.resolvedModel ?? model,
              { promptTokens, completionTokens, cachedTokens, cacheWriteTokens },
              descriptor.billingMode === 'none' ? 0 : descriptor.markup,
              typeof usage.cost === 'number' ? usage.cost : undefined,
              descriptor.pricing,
            );
            await persistGatewayTrace({
              requestId,
              startedAt: new Date(start).toISOString(),
              accountId: principal.accountId,
              actorUserId: principal.userId,
              projectId,
              requestedModel: model,
              resolvedModel,
              provider: shownProvider(descriptor),
              billingMode: descriptor.billingMode,
              streaming: false,
              status: res.status,
              ok: res.ok,
              errorMessage: res.ok
                ? undefined
                : (publicError?.message ?? data?.error?.message ?? data?.message ?? `HTTP ${res.status}`),
              latencyMs,
              attempts: tried.length,
              candidatesTried: tried,
              usage: { promptTokens, completionTokens, cachedTokens, cacheWriteTokens },
              upstreamCost,
              finalCost,
              request,
              response: data,
              metadata: { surface: 'gateway_playground' },
            });
            if (promptTokens + completionTokens > 0) {
              await recordGatewayUsage({
                promptTokens,
                completionTokens,
                cachedTokens,
                cacheWriteTokens,
                accountId: principal.accountId,
                actorUserId: principal.userId,
                projectId,
                provider: shownProvider(descriptor),
                model: resolvedModel,
                ...(descriptor.publicProvider
                  ? { upstream: { provider: descriptor.provider, model: descriptor.resolvedModel ?? model } }
                  : {}),
                upstreamCost,
                finalCost,
                billingMode: descriptor.billingMode,
                streaming: false,
                requestId,
              });
            }
            if (!res.ok) {
              return {
                model,
                ok: false,
                latency_ms: latencyMs,
                error: publicError?.message ?? data?.error?.message ?? data?.message ?? `HTTP ${res.status}`,
              };
            }
            return {
              model,
              ok: true,
              latency_ms: latencyMs,
              output: data?.choices?.[0]?.message?.content ?? '',
              input_tokens: promptTokens,
              output_tokens: completionTokens,
              cost: finalCost,
              resolved_model: resolvedModel,
              provider: shownProvider(descriptor),
            };
          } catch (err) {
            return { model, ok: false, error: playgroundModelError(err, model) };
          }
        }),
      );

      return c.json({ results, gateway_url: publicGatewayBaseUrl(config.LLM_GATEWAY_BASE_URL) });
    },
  );
}
