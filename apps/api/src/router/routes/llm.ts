import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../../types";
import { getAllModels } from "../services/llm";
import { resolveActorFromRequest } from "../../shared/actor-context";
import { getTraceHeaders } from "../../lib/request-context";
import { makeOpenApiApp, json, errors, auth } from "../../openapi";
import { effectHandler } from "../../effect/hono";
import {
  runOpenRouterLlmWorkflow,
  throwLlmWorkflowHttp,
} from "../services/llm-workflow";

const llm = makeOpenApiApp<{ Variables: AppContext }>();

/** OpenAI-compatible model object, as serialized by /models[/{model}]. */
const ModelObjectSchema = z
  .object({
    id: z.string(),
    object: z.string(),
    created: z.number(),
    owned_by: z.string(),
    context_window: z.number().optional(),
    pricing: z.any().optional(),
    tier: z.string().optional(),
  })
  .openapi("LlmModel");

const ModelListSchema = z
  .object({ object: z.string(), data: z.array(ModelObjectSchema) })
  .openapi("LlmModelList");

llm.openapi(
  createRoute({
    method: "post",
    path: "/chat/completions",
    tags: ["router"],
    summary:
      "OpenAI-compatible chat completions (proxied to OpenRouter, supports SSE streaming)",
    ...auth,
    // NOTE: intentionally NO `request.body` schema — the handler parses the body
    // manually (validating model/messages and emitting `Validation error: …`
    // HTTPException(400)). Attaching a schema would let the zod-openapi validator
    // run first and change that contract / consume the proxied body.
    responses: {
      200: {
        description:
          "Chat completion. JSON when non-streaming; a Server-Sent Events stream (text/event-stream) when stream=true.",
        content: {
          "application/json": { schema: z.any() },
          "text/event-stream": { schema: z.string() },
        },
      },
      ...errors(400, 401, 402, 502),
    },
  }),
  async (c) => {
    const accountId = c.get("accountId");
    const actor = resolveActor(c);
    const headerSessionId =
      c.req.header("X-Session-ID") ?? c.get("sandboxId") ?? c.get("keyId");

    try {
      const result = await runOpenRouterLlmWorkflow({
        accountId,
        actor,
        traceHeaders: getTraceHeaders(),
        readJson: () => c.req.json(),
        sessionId: headerSessionId,
      });

      if (result.kind === "json") {
        return c.json(result.body);
      }
      return result.response;
    } catch (error) {
      throwLlmWorkflowHttp(error);
    }
  },
);

llm.openapi(
  createRoute({
    method: "get",
    path: "/models",
    tags: ["router"],
    summary: "List available LLM models (OpenAI-compatible)",
    ...auth,
    responses: {
      200: json(ModelListSchema, "Available models"),
      ...errors(401),
    },
  }),
  effectHandler(async (c) => {
    const models = getAllModels();

    return c.json({
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: m.owned_by,
        context_window: m.context_window,
        pricing: m.pricing,
        tier: m.tier,
      })),
    });
  }),
);

llm.openapi(
  createRoute({
    method: "get",
    path: "/models/{model}",
    tags: ["router"],
    summary: "Get a single LLM model by id (OpenAI-compatible)",
    ...auth,
    request: { params: z.object({ model: z.string() }) },
    responses: {
      200: json(ModelObjectSchema, "The model"),
      ...errors(401, 404),
    },
  }),
  effectHandler(async (c) => {
    const modelId = c.req.param("model");
    const models = getAllModels();
    const model = models.find((m) => m.id === modelId);

    if (!model) {
      throw new HTTPException(404, { message: `Model ${modelId} not found` });
    }

    return c.json({
      id: model.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: model.owned_by,
      context_window: model.context_window,
      pricing: model.pricing,
      tier: model.tier,
    });
  }),
);

function resolveActor(c: Parameters<typeof resolveActorFromRequest>[0]) {
  return resolveActorFromRequest(c, { logPrefix: "[LLM]" });
}

export { llm };
