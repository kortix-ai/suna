import type {
  AuthedPrincipal,
  GatewayTrace,
  UsageEvent,
} from "@kortix/llm-gateway";
import { Effect } from "effect";
import { Hono } from "hono";
import { assertBillingActive } from "../billing/services/billing-gate";
import { effectMiddleware } from "../effect/hono";
import { runHttpEffect } from "../effect/http";
import { checkBudget } from "./budgets";
import {
  authenticatePrincipal,
  authorizeRequest,
  persistGatewayTrace,
  recordGatewayUsage,
} from "./hooks";
import { matchesInternalToken } from "./internal-auth";
import { gatewayModelCatalog } from "./models/catalog-models";
import { resolveCandidates } from "./resolution/resolve-candidates";
import { logger } from "../lib/logger";

type GatewayRouteResult = {
  readonly body: unknown;
  readonly status?: number;
};

const gatewayJson = (body: unknown, status?: number): GatewayRouteResult => ({
  body,
  status,
});

const parseJsonBody = <A = Record<string, unknown>>(
  c: any,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: async () => (await c.req.json()) as A,
    catch: (cause) => cause,
  });

const dependency = <A>(
  operation: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => cause,
  });

async function runGatewayRoute(
  c: any,
  workflow: Effect.Effect<GatewayRouteResult, unknown>,
) {
  const result = await runHttpEffect(workflow);
  if (result.status === undefined) return c.json(result.body);
  return c.json(result.body, result.status as any);
}

// HTTP control plane for the OUT-OF-PROCESS gateway pod. Every handler is a thin
// wrapper over the shared in-process hooks in ./hooks — the standalone service
// and the in-API mount run identical logic; only the transport (HTTP vs direct
// call) differs.
export function createInternalGatewayRoutes() {
  const app = new Hono();
  app.use("*", effectMiddleware);
  const internalToken = process.env.GATEWAY_INTERNAL_TOKEN;

  app.use("*", async (c, next) => {
    if (!internalToken)
      return c.json({ error: "internal gateway disabled" }, 503);
    if (!matchesInternalToken(c.req.header("authorization"), internalToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.post("/authenticate", async (c) => {
    return runGatewayRoute(
      c,
      Effect.gen(function* () {
        const { token } = yield* parseJsonBody<{ token?: unknown }>(c);
        if (typeof token !== "string" || !token)
          return gatewayJson({ principal: null });
        const principal = yield* dependency(() => authenticatePrincipal(token));
        return gatewayJson({ principal });
      }),
    );
  });

  // Combined gate (auth + billing + budget) — lets the standalone gateway fold
  // three sequential RPCs into one on the chat-completions hot path.
  app.post("/authorize", async (c) => {
    return runGatewayRoute(
      c,
      Effect.gen(function* () {
        const { token } = yield* parseJsonBody<{ token?: unknown }>(c);
        if (typeof token !== "string" || !token) {
          return gatewayJson({
            ok: false,
            status: 401,
            errorCode: "invalid_token",
            message: "Invalid token",
          });
        }
        return gatewayJson(yield* dependency(() => authorizeRequest(token)));
      }),
    );
  });

  app.post("/resolve-upstream", async (c) => {
    return runGatewayRoute(
      c,
      Effect.gen(function* () {
        const { principal, model } = yield* parseJsonBody<{
          principal?: unknown;
          model?: unknown;
        }>(c);
        const candidates = yield* dependency(() =>
          resolveCandidates(
            principal as AuthedPrincipal,
            typeof model === "string" ? model : "",
          ),
        );
        return gatewayJson({ candidates });
      }),
    );
  });

  app.post("/budget-check", async (c) => {
    return runGatewayRoute(
      c,
      Effect.gen(function* () {
        const { principal } = yield* parseJsonBody<{ principal?: unknown }>(c);
        return gatewayJson(
          yield* dependency(() => checkBudget(principal as AuthedPrincipal)),
        );
      }),
    );
  });

  app.post("/models", async (c) => {
    return runGatewayRoute(
      c,
      Effect.gen(function* () {
        const { principal } = yield* parseJsonBody<{ principal?: unknown }>(c);
        const p = principal as AuthedPrincipal;
        return gatewayJson({
          models: gatewayModelCatalog(p.projectId, {
            freeManagedOnly: !!p.freeModelsOnly,
          }),
        });
      }),
    );
  });

  app.post("/billing", async (c) => {
    return runGatewayRoute(
      c,
      Effect.gen(function* () {
        const { accountId } = yield* parseJsonBody<{ accountId?: unknown }>(c);
        const checked = yield* Effect.either(
          dependency(() => assertBillingActive(accountId as string)),
        );
        if (checked._tag === "Right") return gatewayJson({ active: true });
        return gatewayJson({
          active: false,
          message:
            checked.left instanceof Error
              ? checked.left.message
              : "subscription required",
        });
      }),
    );
  });

  app.post("/usage", async (c) => {
    return runGatewayRoute(
      c,
      Effect.gen(function* () {
        const { event } = yield* parseJsonBody<{ event?: unknown }>(c);
        yield* dependency(() => recordGatewayUsage(event as UsageEvent));
        return gatewayJson({ ok: true });
      }),
    );
  });

  app.post("/trace", async (c) => {
    return runGatewayRoute(
      c,
      Effect.gen(function* () {
        const { trace } = yield* parseJsonBody<{
          trace?: Partial<GatewayTrace>;
        }>(c);
        if (!trace || typeof trace.requestId !== "string")
          return gatewayJson({ ok: false }, 400);
        // Trace persistence is best-effort observability — never 500 the gateway's
        // fire-and-forget trace post if the write fails.
        const persisted = yield* Effect.either(
          dependency(() => persistGatewayTrace(trace as GatewayTrace)),
        );
        if (persisted._tag === "Left") {
          logger.warn(
            `[gateway] persistGatewayTrace failed for ${trace.requestId}`,
            {
              error:
                persisted.left instanceof Error
                  ? persisted.left.message
                  : String(persisted.left),
            },
          );
          return gatewayJson({ ok: false }, 200);
        }
        return gatewayJson({ ok: true });
      }),
    );
  });

  return app;
}
