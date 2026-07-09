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
import {
  isModelServableForAccount,
} from "../../llm-gateway/resolution/default-model";
import { chooseEffectiveAgent, toOpencodeModelRef } from "../../llm-gateway/resolution/effective";
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

function serializeBinding(row: ChannelBindingRow, projectDefaultAgent: string | null) {
  const effectiveAgent = chooseEffectiveAgent({
    explicit: row.agentName,
    projectDefault: projectDefaultAgent,
  });
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

    const projectDefaultAgent = projectDefaultAgentOf(loaded.row.metadata);
    const bindings = await listChannelBindingsForProject(projectId);
    return c.json({
      projectDefaultAgent,
      bindings: bindings.map((b) => serializeBinding(b, projectDefaultAgent)),
    });
  },
);

const ChannelBindingPatchBody = z.object({
  // null resets the override to the project default; omit to leave unchanged.
  agentName: z.string().max(128).nullable().optional(),
  opencodeModel: z.string().max(256).nullable().optional(),
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
    return c.json(serializeBinding(updated, projectDefaultAgentOf(loaded.row.metadata)));
  },
);
