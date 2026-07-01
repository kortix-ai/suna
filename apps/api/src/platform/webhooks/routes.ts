import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { makeOpenApiApp, json, errors } from "../../openapi";
import { runHttpEffect } from "../../effect/http";
import {
  handleDaytonaWebhook,
  handlePlatinumWebhook,
} from "./sandbox-webhooks";

/**
 * Sandbox lifecycle webhook ingress (NOT billing — these are provider state
 * events that we use to close compute billing + reconcile DB state the instant a
 * box stops). Mounted at /v1/webhooks/sandbox so the path says what it is.
 *
 * This is the FAST path of a deliberate two-tier strategy:
 *   1. webhook (here) — closes billing the moment the provider reports a stop;
 *   2. the reaper sweep (projects/sandbox-reaper.ts) — polls the provider's real
 *      state every maintenance cycle and reconciles/closes anything the webhook
 *      missed. The sweep needs ZERO per-environment config, so local/dev/preview
 *      are fully correct on the reaper alone; webhooks are a prod latency win,
 *      never a correctness dependency.
 *
 * Raw body is required for signature verification, so no JSON body schema is
 * declared. Inert (503) until the matching secret is configured.
 */
export const sandboxWebhooksApp = makeOpenApiApp();

const webhookWorkflow = (
  c: any,
  handler: (
    rawBody: string,
    header: (h: string) => string | undefined,
  ) => Promise<{ status: number; body: Record<string, unknown> }>,
) =>
  Effect.gen(function* () {
    // Signature verification depends on the exact raw body bytes Hono exposes;
    // only the read + provider handler are in Effect, not any JSON body coercion.
    const rawBody = yield* Effect.tryPromise({
      try: () => c.req.text() as Promise<string>,
      catch: (cause) => cause,
    });
    return yield* Effect.tryPromise({
      try: () => handler(rawBody, (h: string) => c.req.header(h)),
      catch: (cause) => cause,
    });
  });

sandboxWebhooksApp.openapi(
  createRoute({
    method: "post",
    path: "/daytona",
    tags: ["webhooks"],
    summary: "Daytona sandbox lifecycle webhook (Svix-signed, public)",
    responses: {
      200: json(z.record(z.string(), z.any()), "Webhook processing result"),
      ...errors(400, 401, 503),
    },
  }),
  async (c: any) => {
    const { status, body } = await runHttpEffect(
      webhookWorkflow(c, handleDaytonaWebhook),
    );
    return c.json(body, status);
  },
);

sandboxWebhooksApp.openapi(
  createRoute({
    method: "post",
    path: "/platinum",
    tags: ["webhooks"],
    summary: "Platinum sandbox lifecycle webhook (HMAC-SHA-256, public)",
    responses: {
      200: json(z.record(z.string(), z.any()), "Webhook processing result"),
      ...errors(400, 401, 503),
    },
  }),
  async (c: any) => {
    const { status, body } = await runHttpEffect(
      webhookWorkflow(c, handlePlatinumWebhook),
    );
    return c.json(body, status);
  },
);
