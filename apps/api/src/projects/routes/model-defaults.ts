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
import { auth, errors, json } from "../../openapi";
import { invalidateAccountModelDefaults } from "../../llm-gateway/resolution/default-model";
import {
  deleteAccountModelPreference,
  getAccountModelDefaults,
  upsertAccountModelPreference,
} from "../../repositories/model-preferences";
import { assertProjectCapability, loadProjectForUser } from "../lib/access";
import { projectsApp } from "../lib/app";
import { PROJECT_ACTIONS } from "../../iam";

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
    const loaded = await loadProjectForUser(c, projectId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    const accountId = loaded.row.accountId as string;
    const defaults = await getAccountModelDefaults(accountId);
    const projectDefault = defaults.projects[projectId] ?? null;
    return c.json({
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
    // Floor 'read'; project.customize.write is the real gate (model defaults are
    // project customization). Built-in editor/manager hold the leaf.
    const loaded = await loadProjectForUser(c, projectId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
    const accountId = loaded.row.accountId as string;
    const userId = c.get("userId") as string;

    const parsed = ModelDefaultBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid body", code: "invalid_body" }, 400);
    const { scope, agentName, model } = parsed.data;
    if (scope === "agent" && !agentName) {
      return c.json({ error: "agentName is required for scope=agent", code: "agent_name_required" }, 400);
    }
    if (!isStorableModel(model)) {
      return c.json({ error: `"${model}" is not a settable model`, code: "invalid_model" }, 400);
    }

    const scopeKey = scope === "project" ? projectId : scope === "agent" ? agentName! : "";
    await upsertAccountModelPreference({ accountId, scope, scopeKey, model, updatedBy: userId });
    invalidateAccountModelDefaults(accountId);
    return c.json({ ok: true, scope, agentName: scope === "agent" ? agentName : undefined, model });
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
    // Floor 'read'; project.customize.write is the real gate (see PUT above).
    const loaded = await loadProjectForUser(c, projectId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
    const accountId = loaded.row.accountId as string;
    const scope = c.req.query("scope");
    const agentName = c.req.query("agentName");
    if (scope !== "account" && scope !== "project" && scope !== "agent") {
      return c.json({ error: "scope must be 'account', 'project', or 'agent'", code: "invalid_scope" }, 400);
    }
    if (scope === "agent" && !agentName) {
      return c.json({ error: "agentName is required for scope=agent", code: "agent_name_required" }, 400);
    }
    const scopeKey = scope === "project" ? projectId : scope === "agent" ? agentName : "";
    await deleteAccountModelPreference({ accountId, scope, scopeKey });
    invalidateAccountModelDefaults(accountId);
    return c.json({ ok: true, scope, agentName: scope === "agent" ? agentName : undefined });
  },
);
