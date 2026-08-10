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
import { accountMayUseManagedModels } from "../../billing/services/entitlements";
import {
  type ChannelBindingRow,
  getChannelBindingById,
  listChannelBindingsForWorkspace,
  loadWorkspaceAgentGovernance,
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
import { WORKSPACE_ACTIONS } from "../../iam";
import { auth, errors, json } from "../../openapi";
import { loadWorkspaceForUser, assertWorkspaceCapability } from "../lib/access";
import { workspaceRoutesApp } from "../lib/app";

/** The three Slack conversation-join policies (channels/slack/participants.ts). */
const CONVERSATION_POLICIES = ["owner_approval", "owner_only", "project_open"] as const;

function workspaceDefaultAgentOf(metadata: unknown): string | null {
  return typeof (metadata as Record<string, unknown> | null)?.default_agent === "string"
    ? ((metadata as Record<string, unknown>).default_agent as string)
    : null;
}

interface ModelResolutionCtx {
  userId: string;
  accountId: string;
  workspaceId: string;
  modelDefaults: AccountModelDefaults;
  freeModelsOnly: boolean;
}

// Mirrors resolveEffectiveModel (default-model.ts) but batches the account
// defaults fetch across every binding in the list instead of re-querying per
// row. A pinned model that's no longer servable (BYOK key disconnected,
// managed model retired) silently degrades to the workspace → account →
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
      workspaceId: ctx.workspaceId,
      freeModelsOnly: ctx.freeModelsOnly,
      model: explicitModel,
    });
    if (servable) return { model: toWireModel(explicitModel), source: "explicit" };
  }
  return chooseEffectiveModel({
    agentDefault: ctx.modelDefaults.agents[agentName] ?? null,
    workspaceDefault: ctx.modelDefaults.workspaces[ctx.workspaceId] ?? null,
    accountDefault: ctx.modelDefaults.account,
    freeModelsOnly: ctx.freeModelsOnly,
  });
}

async function serializeBinding(
  row: ChannelBindingRow,
  workspaceDefaultAgent: string | null,
  modelCtx: ModelResolutionCtx,
) {
  const effectiveAgent = chooseEffectiveAgent({
    explicit: row.agentName,
    workspaceDefault: workspaceDefaultAgent,
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
    opencodeModel: row.opencodeModel,
    conversationPolicy: row.conversationPolicy,
    installedAt: row.installedAt.toISOString(),
    effectiveAgent,
    effectiveModel,
  };
}

// GET /v1/workspaces/:workspaceId/channels/bindings
// Every channel bound to this workspace, with the effective agent resolved
// (explicit binding override || the workspace's declared default) so the UI
// never has to reimplement chooseEffectiveAgent's precedence.
workspaceRoutesApp.openapi(
  createRoute({
    method: "get",
    path: "/{workspaceId}/channels/bindings",
    tags: ["channels"],
    summary: "GET /:workspaceId/channels/bindings",
    ...auth,
    request: { params: z.object({ workspaceId: z.string() }) },
    responses: { 200: json(z.any(), "OK"), ...errors(404) },
  }),
  async (c: any) => {
    const workspaceId = c.req.param("workspaceId");
    const loaded = await loadWorkspaceForUser(c, workspaceId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    // Listing channel↔agent bindings exposes which connectors the workspace's
    // channels talk through — connector-read info. Gate on connector.read so
    // unchecking it in a custom role is denied. Every built-in role holds it.
    await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_READ);

    const accountId = loaded.row.accountId as string;
    const workspaceDefaultAgent = workspaceDefaultAgentOf(loaded.row.metadata);
    const bindings = await listChannelBindingsForWorkspace(workspaceId);
    // Rows created before channel-name persistence existed on every bind path
    // (or created before the workspace's Slack token was available) can still
    // have `channelName === null`. Resolve those live on read so the settings
    // page shows the real Slack channel name on the very next load instead of
    // waiting for the channel's next Slack event.
    await Promise.all(
      bindings
        .filter((b) => b.platform === "slack" && !b.channelName)
        .map(async (b) => {
          b.channelName = await backfillChannelName(b.workspaceId, b.channelId, workspaceId);
        }),
    );
    const modelCtx: ModelResolutionCtx = {
      userId: loaded.userId,
      accountId,
      workspaceId,
      modelDefaults: await getAccountModelDefaults(accountId, workspaceId),
      freeModelsOnly: !(await accountMayUseManagedModels(accountId)),
    };
    return c.json({
      workspaceDefaultAgent,
      bindings: await Promise.all(bindings.map((b) => serializeBinding(b, workspaceDefaultAgent, modelCtx))),
    });
  },
);

const ChannelBindingPatchBody = z.object({
  // null resets the override to the workspace default; omit to leave unchanged.
  agentName: z.string().max(128).nullable().optional(),
  opencodeModel: z.string().max(256).nullable().optional(),
  conversationPolicy: z.enum(CONVERSATION_POLICIES).optional(),
});

// PATCH /v1/workspaces/:workspaceId/channels/bindings/:bindingId
workspaceRoutesApp.openapi(
  createRoute({
    method: "patch",
    path: "/{workspaceId}/channels/bindings/{bindingId}",
    tags: ["channels"],
    summary: "PATCH /:workspaceId/channels/bindings/:bindingId",
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), bindingId: z.string() }),
      body: { content: { "application/json": { schema: ChannelBindingPatchBody } } },
    },
    responses: { 200: json(z.any(), "OK"), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const workspaceId = c.req.param("workspaceId");
    const bindingId = c.req.param("bindingId");
    // Floor 'read'; project.connector.write below is the real gate (was 'manage'
    // → project.write, which over-gated a custom connector.write-only role).
    const loaded = await loadWorkspaceForUser(c, workspaceId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    // No dedicated "channel binding write" leaf exists yet (the channel.* actions
    // in iam/actions.ts are scoped to resource_type='channel' and aren't wired
    // through assertWorkspaceCapability's workspace-scoped fold, and nothing uses them
    // today). Editing which agent/model a channel talks to is the same connector
    // capability that already gates connecting/disconnecting the channel itself
    // (see channels/slack connect|disconnect above) — reuse it rather than invent
    // a parallel gate for the same resource.
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE,
    );

    const binding = await getChannelBindingById(workspaceId, bindingId);
    if (!binding) return c.json({ error: "Not found" }, 404);

    const parsed = ChannelBindingPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid body", code: "invalid_body" }, 400);
    const body = parsed.data;
    if (
      body.agentName === undefined &&
      body.opencodeModel === undefined &&
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
          // Validate against the declared manifest catalog ONLY when the workspace
          // has adopted `[[agents]]` — a legacy (undeclared) project has no fixed
          // catalog to check against, so any name is accepted there (same
          // permissiveness as the Slack `/kortix agent <name>` command).
          const governance = await loadWorkspaceAgentGovernance(workspaceId);
          if (governance.declared && !governance.agents.some((a) => a.name === trimmed)) {
            return c.json(
              {
                error: `"${trimmed}" is not a declared agent in this workspace's manifest`,
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
              error: `"${nextAgent}" is not a declared agent in this workspace's manifest`,
              code: "unknown_agent",
            },
            400,
          );
        }
        return c.json({ error: "Not found" }, 404);
      }
    }

    if (body.opencodeModel !== undefined) {
      let stored: string | null = null;
      if (body.opencodeModel !== null) {
        const trimmed = body.opencodeModel.trim();
        if (!trimmed || /\s/.test(trimmed)) {
          return c.json(
            { error: `"${trimmed}" doesn't look like a model id`, code: "invalid_model" },
            400,
          );
        }
        const freeModelsOnly = !(await accountMayUseManagedModels(loaded.row.accountId as string));
        const servable = await isModelServableForAccount({
          userId: loaded.userId,
          accountId: loaded.row.accountId as string,
          workspaceId,
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

    const updated = await getChannelBindingById(workspaceId, bindingId);
    if (!updated) return c.json({ error: "Not found" }, 404);
    const accountId = loaded.row.accountId as string;
    const modelCtx: ModelResolutionCtx = {
      userId: loaded.userId,
      accountId,
      workspaceId,
      modelDefaults: await getAccountModelDefaults(accountId, workspaceId),
      freeModelsOnly: !(await accountMayUseManagedModels(accountId)),
    };
    return c.json(await serializeBinding(updated, workspaceDefaultAgentOf(loaded.row.metadata), modelCtx));
  },
);
