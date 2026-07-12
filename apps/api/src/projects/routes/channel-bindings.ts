// Channel → agent binding CRUD — the web surface for `chat_channel_bindings`.
//
// Today the only way to point a chat channel (Slack, so far) at a specific
// project agent / model / join-policy is the in-Slack `/kortix agent|model|policy`
// slash commands (channels/slack/commands.ts → selection.ts). That leaves the
// mapping unmanageable from the dashboard — this is the read/write surface spec
// §2.5 ("Channels become manageable") asks for. It's a thin HTTP wrapper: every
// actual read/write goes through the same channels/slack/selection.ts helpers the
// Slack commands use, so the two surfaces can never disagree about how a binding
// is stored or resolved.
import { createRoute, z } from "@hono/zod-openapi";
import { config } from "../../config";
import { getCachedAccountTier } from "../../billing/services/entitlements";
import { tierGrantsAllModels } from "../../billing/services/tiers";
import {
  type ChannelBindingRow,
  getChannelBindingById,
  listChannelBindingsForProject,
  loadProjectAgentGovernance,
  setChannelAgent,
  setChannelConversationPolicy,
  setChannelModel,
} from "../../channels/slack/selection";
import { backfillChannelName } from "../../channels/slack/dispatch";
import {
  isModelServableForAccount,
} from "../../llm-gateway/resolution/default-model";
import {
  type ModelSource,
  chooseEffectiveAgent,
  chooseEffectiveModel,
  toOpencodeModelRef,
  toWireModel,
} from "../../llm-gateway/resolution/effective";
import { type AccountModelDefaults, getAccountModelDefaults } from "../../repositories/model-preferences";
import { PROJECT_ACTIONS } from "../../iam";
import { auth, errors, json } from "../../openapi";
import { loadProjectForUser, assertProjectCapability } from "../lib/access";
import { projectsApp } from "../lib/app";

/** The three Slack conversation-join policies (channels/slack/participants.ts). */
const CONVERSATION_POLICIES = ["owner_approval", "owner_only", "project_open"] as const;

function projectDefaultAgentOf(metadata: unknown): string | null {
  return typeof (metadata as Record<string, unknown> | null)?.default_agent === "string"
    ? ((metadata as Record<string, unknown>).default_agent as string)
    : null;
}

interface ModelResolutionCtx {
  userId: string;
  accountId: string;
  projectId: string;
  modelDefaults: AccountModelDefaults;
  freeModelsOnly: boolean;
}

// Mirrors resolveEffectiveModel (default-model.ts) but batches the account
// defaults fetch across every binding in the list instead of re-querying per
// row. A pinned model that's no longer servable (BYOK key disconnected,
// managed model retired) silently degrades to the project → account →
// platform chain here too, so `effectiveModel.source` never lies about what a
// session from this channel will actually run.
async function resolveBindingEffectiveModel(
  explicitModel: string | null,
  agentName: string,
  ctx: ModelResolutionCtx,
): Promise<{ model: string | null; source: ModelSource }> {
  if (explicitModel) {
    const servable = await isModelServableForAccount({
      userId: ctx.userId,
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      freeModelsOnly: ctx.freeModelsOnly,
      model: explicitModel,
    });
    if (servable) return { model: toWireModel(explicitModel), source: "explicit" };
  }
  return chooseEffectiveModel({
    agentDefault: ctx.modelDefaults.agents[agentName] ?? null,
    projectDefault: ctx.modelDefaults.projects[ctx.projectId] ?? null,
    accountDefault: ctx.modelDefaults.account,
    freeModelsOnly: ctx.freeModelsOnly,
  });
}

async function serializeBinding(
  row: ChannelBindingRow,
  projectDefaultAgent: string | null,
  modelCtx: ModelResolutionCtx,
) {
  const effectiveAgent = chooseEffectiveAgent({
    explicit: row.agentName,
    projectDefault: projectDefaultAgent,
  });
  const effectiveModel = await resolveBindingEffectiveModel(row.opencodeModel, effectiveAgent.agent, modelCtx);
  return {
    bindingId: row.bindingId,
    platform: row.platform,
    workspaceId: row.workspaceId,
    channelId: row.channelId,
    channelName: row.channelName,
    channelType: row.channelType,
    agentName: row.agentName,
    model: row.model,
    conversationPolicy: row.conversationPolicy,
    installedAt: row.installedAt.toISOString(),
    effectiveAgent,
    effectiveModel,
  };
}

// GET /v1/projects/:projectId/channels/bindings
// Every channel bound to this project, with the effective agent resolved
// (explicit binding override || the project's declared default) so the UI
// never has to reimplement chooseEffectiveAgent's precedence.
projectsApp.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/channels/bindings",
    tags: ["channels"],
    summary: "GET /:projectId/channels/bindings",
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), "OK"), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    const loaded = await loadProjectForUser(c, projectId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    // Listing channel↔agent bindings exposes which connectors the project's
    // channels talk through — connector-read info. Gate on connector.read so
    // unchecking it in a custom role is denied. Every built-in role holds it.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);

    const accountId = loaded.row.accountId as string;
    const projectDefaultAgent = projectDefaultAgentOf(loaded.row.metadata);
    const bindings = await listChannelBindingsForProject(projectId);
    // Rows created before channel-name persistence existed on every bind path
    // (or created before the project's Slack token was available) can still
    // have `channelName === null`. Resolve those live on read so the settings
    // page shows the real Slack channel name on the very next load instead of
    // waiting for the channel's next Slack event.
    await Promise.all(
      bindings
        .filter((b) => b.platform === "slack" && !b.channelName)
        .map(async (b) => {
          b.channelName = await backfillChannelName(b.workspaceId, b.channelId, projectId);
        }),
    );
    const modelCtx: ModelResolutionCtx = {
      userId: loaded.userId,
      accountId,
      projectId,
      modelDefaults: await getAccountModelDefaults(accountId),
      freeModelsOnly: config.KORTIX_BILLING_INTERNAL_ENABLED
        ? !tierGrantsAllModels(await getCachedAccountTier(accountId))
        : false,
    };
    return c.json({
      projectDefaultAgent,
      bindings: await Promise.all(bindings.map((b) => serializeBinding(b, projectDefaultAgent, modelCtx))),
    });
  },
);

const ChannelBindingPatchBody = z.object({
  // null resets the override to the project default; omit to leave unchanged.
  agentName: z.string().max(128).nullable().optional(),
  model: z.string().max(256).nullable().optional(),
  conversationPolicy: z.enum(CONVERSATION_POLICIES).optional(),
});

// PATCH /v1/projects/:projectId/channels/bindings/:bindingId
projectsApp.openapi(
  createRoute({
    method: "patch",
    path: "/{projectId}/channels/bindings/{bindingId}",
    tags: ["channels"],
    summary: "PATCH /:projectId/channels/bindings/:bindingId",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), bindingId: z.string() }),
      body: { content: { "application/json": { schema: ChannelBindingPatchBody } } },
    },
    responses: { 200: json(z.any(), "OK"), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param("projectId");
    const bindingId = c.req.param("bindingId");
    // Floor 'read'; project.connector.write below is the real gate (was 'manage'
    // → project.write, which over-gated a custom connector.write-only role).
    const loaded = await loadProjectForUser(c, projectId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    // No dedicated "channel binding write" leaf exists yet (the channel.* actions
    // in iam/actions.ts are scoped to resource_type='channel' and aren't wired
    // through assertProjectCapability's project-scoped fold, and nothing uses them
    // today). Editing which agent/model a channel talks to is the same connector
    // capability that already gates connecting/disconnecting the channel itself
    // (see channels/slack connect|disconnect above) — reuse it rather than invent
    // a parallel gate for the same resource.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );

    const binding = await getChannelBindingById(projectId, bindingId);
    if (!binding) return c.json({ error: "Not found" }, 404);

    const parsed = ChannelBindingPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid body", code: "invalid_body" }, 400);
    const body = parsed.data;
    if (
      body.agentName === undefined &&
      body.model === undefined &&
      body.conversationPolicy === undefined
    ) {
      return c.json({ error: "No fields to update", code: "empty_patch" }, 400);
    }

    const ctx = { teamId: binding.workspaceId, channelId: binding.channelId, platform: binding.platform };

    if (body.agentName !== undefined) {
      let nextAgent: string | null = null;
      if (body.agentName !== null) {
        const trimmed = body.agentName.trim();
        if (!trimmed) {
          return c.json({ error: "agentName cannot be blank — pass null to reset", code: "invalid_agent" }, 400);
        }
        if (trimmed.toLowerCase() !== "default") {
          // Validate against the declared manifest catalog ONLY when the project
          // has adopted `[[agents]]` — a legacy (undeclared) project has no fixed
          // catalog to check against, so any name is accepted there (same
          // permissiveness as the Slack `/kortix agent <name>` command).
          const governance = await loadProjectAgentGovernance(projectId);
          if (governance.declared && !governance.agents.some((a) => a.name === trimmed)) {
            return c.json(
              {
                error: `"${trimmed}" is not a declared agent in this project's manifest`,
                code: "unknown_agent",
              },
              400,
            );
          }
          nextAgent = trimmed;
        }
      }
      const result = await setChannelAgent(ctx, nextAgent);
      if (!result.ok) {
        if (result.reason === "unknown_agent") {
          return c.json(
            {
              error: `"${nextAgent}" is not a declared agent in this project's manifest`,
              code: "unknown_agent",
            },
            400,
          );
        }
        return c.json({ error: "Not found" }, 404);
      }
    }

    if (body.model !== undefined) {
      let stored: string | null = null;
      if (body.model !== null) {
        const trimmed = body.model.trim();
        if (!trimmed || /\s/.test(trimmed)) {
          return c.json(
            { error: `"${trimmed}" doesn't look like a model id`, code: "invalid_model" },
            400,
          );
        }
        const freeModelsOnly = config.KORTIX_BILLING_INTERNAL_ENABLED
          ? !tierGrantsAllModels(await getCachedAccountTier(loaded.row.accountId as string))
          : false;
        const servable = await isModelServableForAccount({
          userId: loaded.userId,
          accountId: loaded.row.accountId as string,
          projectId,
          freeModelsOnly,
          model: trimmed,
        });
        if (!servable) {
          return c.json(
            { error: `Model "${trimmed}" is not available for this account`, code: "model_not_servable" },
            409,
          );
        }
        stored = toOpencodeModelRef(trimmed);
      }
      const ok = await setChannelModel(ctx, stored);
      if (!ok) return c.json({ error: "Not found" }, 404);
    }

    if (body.conversationPolicy !== undefined) {
      const ok = await setChannelConversationPolicy(ctx, body.conversationPolicy);
      if (!ok) return c.json({ error: "Not found" }, 404);
    }

    const updated = await getChannelBindingById(projectId, bindingId);
    if (!updated) return c.json({ error: "Not found" }, 404);
    const accountId = loaded.row.accountId as string;
    const modelCtx: ModelResolutionCtx = {
      userId: loaded.userId,
      accountId,
      projectId,
      modelDefaults: await getAccountModelDefaults(accountId),
      freeModelsOnly: config.KORTIX_BILLING_INTERNAL_ENABLED
        ? !tierGrantsAllModels(await getCachedAccountTier(accountId))
        : false,
    };
    return c.json(await serializeBinding(updated, projectDefaultAgentOf(loaded.row.metadata), modelCtx));
  },
);
