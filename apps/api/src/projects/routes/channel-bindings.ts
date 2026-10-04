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
import { config } from "../../lib/config";
import { accountMayUseManagedModels } from "../../billing/services/entitlements";
import {
  type ChannelBindingRow,
  getChannelBindingById,
  listChannelBindingsForProject,
  loadProjectAgentGovernance,
  setChannelAgent,
  setChannelConversationPolicy,
  setChannelModel,
} from "../../channels/slack/selection";
import { backfillSlackBindingLabel } from "../../channels/slack/binding-label";
import { loadSlackTokenForProject, loadTeamsServiceUrlForProject } from "../../channels/install-store";
import { teamsThreadTitles } from "../../channels/teams/binding";
import { backfillTeamsBindingLabel, needsTeamsNameBackfill } from "../../channels/teams/channel-label";
import { isTeamsChannelThreadId } from "../../channels/teams/util";
import { requestMemo } from "../../lib/request-context";
import { withTimeout } from "../../lib/with-timeout";
import {
  isModelServableForAccount,
} from "../../llm-gateway/resolution/default-model";
import { projectLlmGatewayEnabled } from "../../llm-gateway/enablement";
import { resolveFeatureFlag } from "../../feature-flags/registry";
import { usableProviderKeys } from "../../secrets/provider-key-selection";
import { validateNativeOpencodeModelRef } from "../lib/session-model-change";
import {
  type ModelSource,
  chooseEffectiveAgent,
  chooseEffectiveModel,
  toWireModel,
} from "../../llm-gateway/resolution/effective";
import { type AccountModelDefaults, getAccountModelDefaults } from "../../repositories/model-preferences";
import { PROJECT_ACTIONS } from "../../iam";
import { auth, errors, json } from "../../openapi";
import { loadProjectForUser, assertProjectCapability } from "../lib/access";
import { projectsApp } from "../lib/app";

/** The three Slack conversation-join policies (channels/slack/participants.ts). */
const CONVERSATION_POLICIES = ["owner_approval", "owner_only", "project_open"] as const;

/** How long `GET /channels/bindings` waits for Teams to name unnamed threads. */
const TEAMS_NAMING_BUDGET_MS = 2_500;

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
  /** The project's `llm_gateway` flag. Off ⇒ native OpenCode owns model
   *  resolution: an explicit pin reports verbatim and the gateway default
   *  chain is not consulted. */
  llmGatewayEnabled: boolean;
  /** The project's `pooled_provider_secrets` flag. */
  pooledEnabled: boolean;
}

/**
 * Can a chat conversation's sessions run `model`? A conversation is shared, so
 * only what its sessions will reach counts: Kortix models, the project's own
 * keys, and pooled keys shared with the whole project — which those sessions
 * select (channels/model-access.ts). Nobody's personal key or ChatGPT
 * connection counts: a shared session never reaches one (spec 2026-09-22
 * §2.3), and a conversation pinned to one failed every message with
 * "Connect Codex to use this model".
 */
async function conversationCanRunUncached(input: {
  userId: string;
  accountId: string;
  projectId: string;
  freeModelsOnly: boolean;
  pooledEnabled: boolean;
  model: string;
}): Promise<boolean> {
  const base = {
    userId: input.userId,
    accountId: input.accountId,
    projectId: input.projectId,
    freeModelsOnly: input.freeModelsOnly,
    model: input.model,
    personalUserId: null,
  };
  if (await isModelServableForAccount(base)) return true;
  if (!input.pooledEnabled) return false;
  const keys = await usableProviderKeys({
    accountId: input.accountId,
    projectId: input.projectId,
    userId: input.userId,
    grantUserId: null,
    model: input.model,
  }).catch(() => null);
  return keys ? isModelServableForAccount({ ...base, providerSecretPools: { [keys.providerId]: keys.secretIds } }) : false;
}

/**
 * Request-scoped memo over {@link conversationCanRunUncached}.
 *
 * `GET /channels/bindings` calls this once per binding via
 * `resolveBindingEffectiveModel` (N+1: measured 93 DB queries / 621ms server
 * time across ~29 bindings in prod, 2026-09-27). Multiple channels commonly
 * pin the SAME model, and every other input is constant across the whole
 * request (one project, one requesting user) — so the only key that varies is
 * `model`. `requestMemo` collapses repeats to one servability probe per unique
 * model for the lifetime of this request; it never persists across requests,
 * so a key just revoked/granted is still re-checked on the very next call.
 */
async function conversationCanRun(input: {
  userId: string;
  accountId: string;
  projectId: string;
  freeModelsOnly: boolean;
  pooledEnabled: boolean;
  model: string;
}): Promise<boolean> {
  const key = `channel-bindings:conversationCanRun:${input.accountId}:${input.projectId}:${input.userId}:${input.freeModelsOnly}:${input.pooledEnabled}:${input.model}`;
  return requestMemo(key, () => conversationCanRunUncached(input));
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
  oneToOne = false,
): Promise<{ model: string | null; source: ModelSource }> {
  if (!ctx.llmGatewayEnabled) {
    // Native mode: the pin is a native `provider/model` ref OpenCode resolves
    // in the box; the gateway's servability probe and wire-model defaults do
    // not apply. No pin ⇒ OpenCode's own default (reported as platform/null).
    if (explicitModel) return { model: explicitModel, source: "explicit" };
    return { model: null, source: "platform" };
  }
  if (explicitModel) {
    const servable = await conversationCanRun({
      userId: ctx.userId,
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      freeModelsOnly: ctx.freeModelsOnly,
      pooledEnabled: ctx.pooledEnabled,
      model: explicitModel,
    });
    if (servable) return { model: toWireModel(explicitModel), source: "explicit" };
    // A one-to-one chat's sessions are private to its person, whose own keys
    // and ChatGPT subscription count there; they picked this model with them
    // (`/model`). This view runs as someone else and cannot check those keys.
    if (oneToOne) return { model: toWireModel(explicitModel), source: "explicit" };
  }
  return chooseEffectiveModel({
    agentDefault: ctx.modelDefaults.agents[agentName] ?? null,
    projectDefault: ctx.modelDefaults.projects[ctx.projectId] ?? null,
    accountDefault: ctx.modelDefaults.account,
    freeModelsOnly: ctx.freeModelsOnly,
  });
}

/** A one-to-one chat with the bot: a Teams personal chat, a Slack DM. */
function oneToOneConversation(row: ChannelBindingRow): boolean {
  if (row.platform === "teams") return row.channelType === "personal";
  if (row.platform === "slack") return row.channelId.startsWith("D");
  return false;
}

/**
 * Should `GET /channels/bindings` ask Slack to name this row?
 *
 * Every Slack row without a stored name, DMs included: a DM is named after the
 * other person (`users.info`). The answer is stored, so a row costs Slack calls
 * once; a lookup that names nothing is not repeated for 10 minutes
 * (`channels/slack/binding-label.ts`). Before that, DMs were excluded because
 * their lookup never named anything and repeated on every poll (measured prod:
 * 29 HTTP calls / 453 ms on one project).
 */
export function needsSlackNameBackfill(binding: ChannelBindingRow): boolean {
  return binding.platform === "slack" && !binding.channelName;
}

async function serializeBinding(
  row: ChannelBindingRow,
  projectDefaultAgent: string | null,
  modelCtx: ModelResolutionCtx,
  channelUnavailable = false,
  threadTitle: string | null = null,
) {
  const effectiveAgent = chooseEffectiveAgent({
    explicit: row.agentName,
    projectDefault: projectDefaultAgent,
  });
  const effectiveModel = await resolveBindingEffectiveModel(
    row.opencodeModel,
    effectiveAgent.agent,
    modelCtx,
    oneToOneConversation(row),
  );
  return {
    bindingId: row.bindingId,
    platform: row.platform,
    workspaceId: row.workspaceId,
    channelId: row.channelId,
    channelName: row.channelName,
    channelType: row.channelType,
    // Slack answered that the conversation is deleted or out of the bot's reach.
    channelUnavailable,
    // A Teams channel thread: its session's title. Every thread of a channel
    // is its own binding named `Team › Channel`; this tells them apart.
    threadTitle,
    agentName: row.agentName,
    opencodeModel: row.opencodeModel,
    conversationPolicy: row.conversationPolicy,
    installedAt: row.installedAt.toISOString(),
    effectiveAgent,
    effectiveModel,
  };
}

const ChannelBindingPatchBody = z.object({
  // null resets the override to the project default; omit to leave unchanged.
  agentName: z.string().max(128).nullable().optional(),
  opencodeModel: z.string().max(256).nullable().optional(),
  conversationPolicy: z.enum(CONVERSATION_POLICIES).optional(),
});
export function registerChannelBindingsRoutes(): void {
  // GET /v1/projects/:projectId/channels/bindings
  // Every channel bound to this project, with the effective agent resolved
  // (explicit binding override || the project's declared default) so the UI
  // never has to reimplement chooseEffectiveAgent's precedence.
  projectsApp.openapi(
    createRoute({
      method: "get",
      path: "/{projectId}/channels/bindings",
      tags: ["channels"],
      summary: "List channel bindings of a project",
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
      // A Slack row without a stored name is named on read, and the name is
      // stored, so the settings page shows `#general` or a person's name on the
      // very next load. The bot token is the SAME for every Slack binding in
      // this project: load it once (each load decrypts a project secret). Five
      // lookups at a time keep a first load with many DMs under Slack's rate
      // limits.
      const needsBackfill = bindings.filter(needsSlackNameBackfill);
      const unavailable = new Set<string>();
      if (needsBackfill.length > 0) {
        const slackToken = await loadSlackTokenForProject(projectId);
        for (let i = 0; i < needsBackfill.length; i += 5) {
          await Promise.all(
            needsBackfill.slice(i, i + 5).map(async (b) => {
              const label = await backfillSlackBindingLabel(b.workspaceId, b.channelId, projectId, slackToken);
              b.channelName = label.name;
              b.channelType = label.type ?? b.channelType;
              if (label.unavailable) unavailable.add(b.bindingId);
            }),
          );
        }
      }
      // A Teams channel thread whose name does not say its team is named on read
      // when its id does: the General channel's id is the team's id. The name is
      // stored, and one Teams read per team serves every thread in it. A cold
      // read is ~1.4 s (token + connector, measured); the list waits for names
      // at most TEAMS_NAMING_BUDGET_MS, and a lookup still running stores its
      // name for the next load.
      const teamsUnnamed = bindings.filter(needsTeamsNameBackfill);
      const teamsServiceUrl = teamsUnnamed.length > 0 ? await loadTeamsServiceUrlForProject(projectId).catch(() => null) : null;
      if (teamsServiceUrl) {
        const naming = (async () => {
          for (let i = 0; i < teamsUnnamed.length; i += 5) {
            await Promise.all(
              teamsUnnamed.slice(i, i + 5).map(async (b) => {
                const name = await backfillTeamsBindingLabel(b, projectId, teamsServiceUrl);
                if (name) {
                  b.channelName = name;
                  b.channelType = "channel";
                }
              }),
            );
          }
        })();
        await withTimeout(naming, TEAMS_NAMING_BUDGET_MS).catch(() => {});
      }
      const [modelDefaults, mayUseManagedModels, threadTitles] = await Promise.all([
        getAccountModelDefaults(accountId, projectId),
        accountMayUseManagedModels(accountId),
        teamsThreadTitles(
          projectId,
          bindings.filter((b) => b.platform === "teams" && isTeamsChannelThreadId(b.channelId)).map((b) => b.channelId),
        ),
      ]);
      const modelCtx: ModelResolutionCtx = {
        userId: loaded.userId,
        accountId,
        projectId,
        modelDefaults,
        freeModelsOnly: !mayUseManagedModels,
        llmGatewayEnabled: projectLlmGatewayEnabled(loaded.row.metadata),
        pooledEnabled: resolveFeatureFlag(loaded.row.metadata, "pooled_provider_secrets"),
      };
      return c.json({
        projectDefaultAgent,
        bindings: await Promise.all(
          bindings.map((b) =>
            serializeBinding(
              b,
              projectDefaultAgent,
              modelCtx,
              unavailable.has(b.bindingId),
              threadTitles.get(b.channelId) ?? null,
            ),
          ),
        ),
      });
    },
  );

  // PATCH /v1/projects/:projectId/channels/bindings/:bindingId
  projectsApp.openapi(
    createRoute({
      method: "patch",
      path: "/{projectId}/channels/bindings/{bindingId}",
      tags: ["channels"],
      summary: "Update a channel binding",
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
          // Same two-path gate as session create (lib/sessions.ts): gateway ON
          // validates via the gateway resolver and stores the wire id;
          // gateway OFF (native OpenCode) enforces the native `provider/model`
          // shape and stores the ref verbatim.
          if (!projectLlmGatewayEnabled(loaded.row.metadata)) {
            const nativeShapeError = validateNativeOpencodeModelRef(trimmed);
            if (nativeShapeError) {
              return c.json({ error: nativeShapeError.message, code: "invalid_model" }, 400);
            }
            stored = trimmed;
          } else {
          const freeModelsOnly = !(await accountMayUseManagedModels(loaded.row.accountId as string));
          const servable = await conversationCanRun({
            userId: loaded.userId,
            accountId: loaded.row.accountId as string,
            projectId,
            freeModelsOnly,
            pooledEnabled: resolveFeatureFlag(loaded.row.metadata, "pooled_provider_secrets"),
            model: trimmed,
          });
          if (!servable) {
            return c.json(
              {
                error: `Model "${trimmed}" is not available to this conversation. A conversation is shared: it can run Kortix models and keys shared with the whole project, not anyone's own key or ChatGPT subscription.`,
                code: "model_not_servable",
              },
              409,
            );
          }
          stored = toWireModel(trimmed);
          }
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
        modelDefaults: await getAccountModelDefaults(accountId, projectId),
        freeModelsOnly: !(await accountMayUseManagedModels(accountId)),
        llmGatewayEnabled: projectLlmGatewayEnabled(loaded.row.metadata),
        pooledEnabled: resolveFeatureFlag(loaded.row.metadata, "pooled_provider_secrets"),
      };
      return c.json(await serializeBinding(updated, projectDefaultAgentOf(loaded.row.metadata), modelCtx));
    },
  );
}
