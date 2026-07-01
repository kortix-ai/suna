// Model-defaults CRUD — the SDK/UI surface for setting the default model at
// account (personal), project, and agent scope. The committed kortix.toml holds
// an agent's/trigger's declarative model; these routes manage the dynamic,
// per-account defaults the gateway resolves `auto` against.
//
// Entitlement is NOT enforced here — the gateway is the source of truth and
// rejects an unavailable model at request time. We only sanity-check the wire
// form so a default can't be obvious garbage that 400s every session.

import { createRoute, z } from "@hono/zod-openapi";
import { AUTO_MODEL_ID, getManagedModel } from "@kortix/llm-catalog";
import { Effect } from "effect";
import { auth, errors, json } from "../../openapi";
import { invalidateAccountModelDefaults } from "../../llm-gateway/resolution/default-model";
import {
  deleteAccountModelPreference,
  getAccountModelDefaults,
  upsertAccountModelPreference,
} from "../../repositories/model-preferences";
import { loadProjectForUser } from "../lib/access";
import { projectsApp } from "../lib/app";
import { attemptRoute, attemptRouteSync, failJson, failNotFound, routeJson, runProjectRouteEffect } from "./effect-workflows";

/** A storable default must be a concrete model — a managed id (bare or
 *  kortix/-prefixed), or a `provider/model` BYOK/direct wire — never the
 *  synthetic `auto` ("Default" = no row, i.e. DELETE). */
function isStorableModel(model: string): boolean {
  if (model === AUTO_MODEL_ID || model === `kortix/${AUTO_MODEL_ID}`) return false;
  return model.includes("/") || !!getManagedModel(model);
}

const ModelDefaultBody = z.object({
  scope: z.enum(["account", "project", "agent"]),
  // Required for scope=agent (the agent name). Ignored for account/project —
  // project scope keys off the route's projectId.
  agentName: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(128),
});

projectsApp.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/model-defaults",
    tags: ["projects"],
    summary: "GET /:projectId/model-defaults",
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), "OK"), ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    return runProjectRouteEffect(c, Effect.gen(function* () {
      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, "read"));
      if (!loaded) return yield* failNotFound();
      const accountId = loaded.row.accountId as string;
      const defaults = yield* attemptRoute(() => getAccountModelDefaults(accountId));
      const projectDefault = defaults.projects[projectId] ?? null;
      return routeJson({
        // The platform default is the synthetic `auto` (the gateway resolves it).
        platformDefault: AUTO_MODEL_ID,
        accountDefault: defaults.account,
        projectDefault,
        agentDefaults: defaults.agents,
        // Project/account-level resolution for the caller; agent defaults are
        // applied per-agent by the client from agentDefaults. No freeTier — the
        // catalog already encodes availability.
        resolvedForCaller: projectDefault ?? defaults.account ?? AUTO_MODEL_ID,
      });
    }));
  },
);

projectsApp.openapi(
  createRoute({
    method: "put",
    path: "/{projectId}/model-defaults",
    tags: ["projects"],
    summary: "PUT /:projectId/model-defaults",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { "application/json": { schema: ModelDefaultBody } } },
    },
    responses: { 200: json(z.any(), "OK"), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    return runProjectRouteEffect(c, Effect.gen(function* () {
      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, "manage"));
      if (!loaded) return yield* failNotFound();
      const accountId = loaded.row.accountId as string;
      const userId = c.get("userId") as string;

      const rawBody = yield* attemptRoute(async () => c.req.json().catch(() => null));
      const parsed = yield* attemptRouteSync(() => ModelDefaultBody.safeParse(rawBody));
      if (!parsed.success) return yield* failJson({ error: "Invalid body", code: "invalid_body" }, 400);
      const { scope, agentName, model } = parsed.data;
      if (scope === "agent" && !agentName) {
        return yield* failJson({ error: "agentName is required for scope=agent", code: "agent_name_required" }, 400);
      }
      if (!isStorableModel(model)) {
        return yield* failJson({ error: `"${model}" is not a settable model`, code: "invalid_model" }, 400);
      }

      const scopeKey = scope === "project" ? projectId : scope === "agent" ? agentName! : "";
      yield* attemptRoute(() => upsertAccountModelPreference({ accountId, scope, scopeKey, model, updatedBy: userId }));
      yield* attemptRouteSync(() => invalidateAccountModelDefaults(accountId));
      return routeJson({ ok: true, scope, agentName: scope === "agent" ? agentName : undefined, model });
    }));
  },
);

projectsApp.openapi(
  createRoute({
    method: "delete",
    path: "/{projectId}/model-defaults",
    tags: ["projects"],
    summary: "DELETE /:projectId/model-defaults",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({
        scope: z.enum(["account", "project", "agent"]),
        agentName: z.string().min(1).max(128).optional(),
      }),
    },
    responses: { 200: json(z.any(), "OK"), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    return runProjectRouteEffect(c, Effect.gen(function* () {
      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, "manage"));
      if (!loaded) return yield* failNotFound();
      const accountId = loaded.row.accountId as string;
      const scope = c.req.query("scope");
      const agentName = c.req.query("agentName");
      if (scope !== "account" && scope !== "project" && scope !== "agent") {
        return yield* failJson({ error: "scope must be 'account', 'project', or 'agent'", code: "invalid_scope" }, 400);
      }
      if (scope === "agent" && !agentName) {
        return yield* failJson({ error: "agentName is required for scope=agent", code: "agent_name_required" }, 400);
      }
      const scopeKey = scope === "project" ? projectId : scope === "agent" ? agentName : "";
      yield* attemptRoute(() => deleteAccountModelPreference({ accountId, scope, scopeKey }));
      yield* attemptRouteSync(() => invalidateAccountModelDefaults(accountId));
      return routeJson({ ok: true, scope, agentName: scope === "agent" ? agentName : undefined });
    }));
  },
);
