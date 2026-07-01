/**
 * Public URL Share Endpoints — /v1/p/share
 *
 * Proxies to the sandbox's /kortix/share endpoints so the frontend can create,
 * list, and revoke share links without talking to the sandbox directly.
 *
 * Provider-neutral: every session resolves through the session sandbox
 * proxy table before this route talks to the sandbox daemon.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect, Either } from "effect";
import type { Context } from "hono";
import { resolveProvider } from "../index";
import { combinedAuth } from "../../middleware/auth";
import { canAccessPreviewSandbox } from "../../shared/preview-ownership";
import { makeOpenApiApp, json, errors, auth } from "../../openapi";
import {
  attemptProxy,
  failJson,
  jsonResult,
  parseJsonBody,
  runProxyRouteEffect,
} from "./effect-workflows";
import { sandboxProxyFetch } from "../effect";

const shareApp = makeOpenApiApp();
type ResolvedProvider = NonNullable<
  Awaited<ReturnType<typeof resolveProvider>>
>;

// Share results are whatever the sandbox daemon's /kortix/share endpoint
// returns (opaque), or our own { error } envelope — model permissively.
const ShareResultSchema = z.record(z.string(), z.any()).openapi("ShareResult");

function buildSandboxShareBaseUrl(resolved: ResolvedProvider): string | null {
  if (resolved.baseUrl) {
    return `${resolved.baseUrl}/kortix/share`;
  }
  return null;
}

function buildSandboxHeaders(
  resolved: ResolvedProvider,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (resolved.serviceKey) {
    headers.Authorization = `Bearer ${resolved.serviceKey}`;
  }
  return headers;
}

async function parseJsonResponse(
  resp: Response,
): Promise<Record<string, unknown>> {
  const text = await resp.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function resolveShareTargetEffect(sandboxId: string): Effect.Effect<
  {
    resolved: ResolvedProvider;
    sandboxShareBaseUrl: string;
  },
  unknown
> {
  return Effect.gen(function* () {
    const resolved = yield* attemptProxy(() => resolveProvider(sandboxId));
    if (!resolved) {
      return yield* failJson({ error: "Sandbox not found or not active" }, 404);
    }

    const sandboxShareBaseUrl = buildSandboxShareBaseUrl(resolved);
    if (!sandboxShareBaseUrl) {
      return yield* failJson({ error: "Cannot reach sandbox" }, 502);
    }

    return { resolved, sandboxShareBaseUrl };
  });
}

function ensureShareAccessEffect(c: Context, sandboxId: string) {
  return Effect.gen(function* () {
    const userId = c.get("userId") as string | undefined;
    const accountId = c.get("accountId") as string | undefined;

    if (
      userId &&
      (yield* attemptProxy(() =>
        canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId }),
      ))
    ) {
      return;
    }
    if (
      accountId &&
      (yield* attemptProxy(() =>
        canAccessPreviewSandbox({ previewSandboxId: sandboxId, accountId }),
      ))
    ) {
      return;
    }
    return yield* failJson(
      { error: "Not authorized to access this sandbox" },
      403,
    );
  });
}

function sandboxShareFetchEffect(
  sandboxUrl: string,
  init: RequestInit,
  logLabel: string,
  failureMessage: string,
) {
  return Effect.gen(function* () {
    const result = yield* Effect.either(
      attemptProxy(async () => {
        const resp = await sandboxProxyFetch(sandboxUrl, init);
        const body = await parseJsonResponse(resp);
        return { body, status: resp.status };
      }),
    );

    if (Either.isLeft(result)) {
      console.error(logLabel, result.left);
      return yield* failJson({ error: failureMessage }, 502);
    }

    return result.right;
  });
}

const createShareWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const body = yield* parseJsonBody<{
      sandbox_id: string;
      port: number;
      ttl?: string;
      label?: string;
    }>(c, { error: "Invalid JSON body" });

    const { sandbox_id, port, ttl, label } = body;
    if (!sandbox_id || typeof sandbox_id !== "string") {
      return yield* failJson({ error: "sandbox_id is required (string)" }, 400);
    }
    if (!port || typeof port !== "number" || port < 1 || port > 65535) {
      return yield* failJson({ error: "port is required (1-65535)" }, 400);
    }

    yield* ensureShareAccessEffect(c, sandbox_id);
    const target = yield* resolveShareTargetEffect(sandbox_id);

    const queryParams = new URLSearchParams();
    if (ttl) queryParams.set("ttl", ttl);
    if (label) queryParams.set("label", label);
    const qs = queryParams.toString() ? `?${queryParams.toString()}` : "";
    const sandboxUrl = `${target.sandboxShareBaseUrl}/${port}${qs}`;
    const result = yield* sandboxShareFetchEffect(
      sandboxUrl,
      {
        headers: buildSandboxHeaders(target.resolved),
        signal: AbortSignal.timeout(10_000),
      },
      "[share] create share link failed:",
      "Failed to create share link",
    );
    return jsonResult(result.body, result.status);
  });

const listSharesWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const sandbox_id = c.req.query("sandbox_id");
    if (!sandbox_id || typeof sandbox_id !== "string") {
      return yield* failJson({ error: "sandbox_id is required (string)" }, 400);
    }

    yield* ensureShareAccessEffect(c, sandbox_id);
    const target = yield* resolveShareTargetEffect(sandbox_id);
    const result = yield* sandboxShareFetchEffect(
      target.sandboxShareBaseUrl,
      {
        headers: buildSandboxHeaders(target.resolved),
        signal: AbortSignal.timeout(10_000),
      },
      "[share] load share links failed:",
      "Failed to load share links",
    );
    return jsonResult(result.body, result.status);
  });

const revokeShareWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const sandbox_id = c.req.query("sandbox_id");
    if (!sandbox_id || typeof sandbox_id !== "string") {
      return yield* failJson({ error: "sandbox_id is required (string)" }, 400);
    }

    const token = c.req.param("token");
    if (!token) {
      return yield* failJson({ error: "token is required" }, 400);
    }

    yield* ensureShareAccessEffect(c, sandbox_id);
    const target = yield* resolveShareTargetEffect(sandbox_id);
    const result = yield* sandboxShareFetchEffect(
      `${target.sandboxShareBaseUrl}/${encodeURIComponent(token)}`,
      {
        method: "DELETE",
        headers: buildSandboxHeaders(target.resolved),
        signal: AbortSignal.timeout(10_000),
      },
      "[share] revoke share link failed:",
      "Failed to revoke share link",
    );
    return jsonResult(result.body, result.status);
  });

shareApp.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["preview"],
    summary: "Create a public share link for a sandbox port",
    ...auth,
    middleware: [combinedAuth] as const,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              sandbox_id: z.string(),
              port: z.number().int().min(1).max(65535),
              ttl: z.string().optional(),
              label: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        ShareResultSchema,
        "Share link (proxied from the sandbox daemon)",
      ),
      ...errors(400, 401, 403, 404, 502),
    },
  }),
  // Manual body parsing retained: the original contract returns a custom
  // { error: 'Invalid JSON body' } / field-specific 400s before any access
  // check, and proxies the sandbox's opaque status code through unchanged.
  async (c: any) => {
    return runProxyRouteEffect(c, createShareWorkflow(c));
  },
);

shareApp.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["preview"],
    summary: "List public share links for a sandbox",
    ...auth,
    middleware: [combinedAuth] as const,
    request: {
      query: z.object({ sandbox_id: z.string() }),
    },
    responses: {
      200: json(
        ShareResultSchema,
        "Share links (proxied from the sandbox daemon)",
      ),
      ...errors(400, 401, 403, 404, 502),
    },
  }),
  // Manual query read kept — original returns a custom 400 envelope and proxies
  // the sandbox's status code through.
  async (c: any) => {
    return runProxyRouteEffect(c, listSharesWorkflow(c));
  },
);

shareApp.openapi(
  createRoute({
    method: "delete",
    path: "/{token}",
    tags: ["preview"],
    summary: "Revoke a public share link",
    ...auth,
    middleware: [combinedAuth] as const,
    request: {
      params: z.object({ token: z.string() }),
      query: z.object({ sandbox_id: z.string() }),
    },
    responses: {
      200: json(
        ShareResultSchema,
        "Revocation result (proxied from the sandbox daemon)",
      ),
      ...errors(400, 401, 403, 404, 502),
    },
  }),
  // Manual param/query read kept — original returns field-specific 400 envelopes
  // and proxies the sandbox's status code through.
  async (c: any) => {
    return runProxyRouteEffect(c, revokeShareWorkflow(c));
  },
);

export { shareApp };
