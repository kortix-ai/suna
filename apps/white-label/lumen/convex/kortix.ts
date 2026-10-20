"use node";

// Every Kortix call Lumen makes with the operator credential. The credential
// lives only in Convex env (KORTIX_OPERATOR_TOKEN); Next.js and the browser
// never hold it. Members get short-lived project-scoped tokens minted here.

import { updateAgentConfig, updateProjectDefaultAgent } from "@kortix/sdk";
import { createScopedKortix, runWithKortix } from "@kortix/sdk/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, action, internalAction } from "./_generated/server";
import { requireProxy } from "./access";
import { lumenSessionTags } from "./tags";

const MEMBER_TOKEN_TTL_MS = 60 * 60_000;

function operator() {
  const backendUrl = process.env.KORTIX_UPSTREAM;
  const token = process.env.KORTIX_OPERATOR_TOKEN;
  if (!backendUrl || !token) throw new Error("500: KORTIX_UPSTREAM / KORTIX_OPERATOR_TOKEN unset");
  const config = { backendUrl, getToken: async () => token };
  return { config, kortix: createScopedKortix(config) };
}

/** Mint a project-scoped token that expires, and revoke it at expiry so it never piles up as "active". */
async function mintScopedToken(ctx: ActionCtx, name: string, projectId: string, ttlMs: number) {
  const expiresAt = Date.now() + ttlMs;
  const minted = await operator().kortix.accounts.tokens.create({
    name: name.slice(0, 64),
    projectId,
    expiresAt: new Date(expiresAt).toISOString(),
  });
  await ctx.scheduler.runAt(expiresAt, internal.kortix.revokeToken, { tokenId: minted.token_id });
  return { tokenId: minted.token_id, secret: minted.secret_key, expiresAt };
}

/** workspace → Kortix project with the template's agent as the project default. Idempotent per workspace. */
export const provisionWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const row = await ctx.runQuery(internal.workspaces.forProvision, { workspaceId });
    if (!row || row.ws.status !== "provisioning") return null;
    let kortixProjectId: string;
    try {
      const { config, kortix } = operator();
      const project = await kortix.projects.provision({
        name: `lumen-${row.ws.name}`.slice(0, 80),
        idempotency_key: workspaceId,
      });
      const agentName = row.ws.templateSlug;
      // ponytail: agent config is not on the scoped facade yet (contract G1), so it runs inside runWithKortix.
      await runWithKortix(config, async () => {
        await updateAgentConfig(project.project_id, agentName, {
          enabled: true,
          behavior: { mode: "primary", prompt: row.agent.prompt, ...(row.agent.model ? { model: row.agent.model } : {}) },
          ...(row.agent.skills ? { skills: row.agent.skills } : {}),
        });
        await updateProjectDefaultAgent(project.project_id, agentName);
      });
      kortixProjectId = project.project_id;
    } catch (err) {
      // The customer sees a generic message; the Kortix error stays in auditEvents.
      const detail = String((err as Error)?.message ?? err).slice(0, 500);
      await ctx.runMutation(internal.workspaces.settle, { workspaceId, kortixProjectId: null, error: detail });
      return null;
    }
    // Outside the try: a failed settle is a Convex hiccup (a timeout under
    // load), not a failed Kortix project, so it is retried. After the last
    // attempt the workspace is marked failed; "Try again" re-runs this action
    // and the idempotency key returns the same project.
    for (let attempt = 1; ; attempt++) {
      try {
        await ctx.runMutation(internal.workspaces.settle, { workspaceId, kortixProjectId });
        break;
      } catch (err) {
        if (attempt === 3) {
          const detail = `settle: ${String((err as Error)?.message ?? err)}`.slice(0, 500);
          await ctx.runMutation(internal.workspaces.settle, { workspaceId, kortixProjectId: null, error: detail });
          break;
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    return null;
  },
});

/** A member opens a thread: one Kortix session on the template's agent, tagged with Lumen's ids. */
export const createThread = action({
  args: { workspaceId: v.id("workspaces"), title: v.string() },
  returns: v.object({ threadId: v.id("threads"), kortixProjectId: v.string(), kortixSessionId: v.string() }),
  handler: async (
    ctx,
    { workspaceId, title },
  ): Promise<{ threadId: Id<"threads">; kortixProjectId: string; kortixSessionId: string }> => {
    const a = await ctx.runQuery(internal.workspaces.access, { workspaceId });
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 120) || "New thread";
    const session = await operator().kortix.projects.createSession(a.kortixProjectId, {
      name: clean,
      agent_name: a.templateSlug,
      ...lumenSessionTags(a, workspaceId),
    });
    // The session exists now: retry the record (idempotent per session) so a
    // Convex hiccup does not leave a tagged session with no thread row.
    const recordArgs = { workspaceId, orgId: a.orgId, userId: a.userId, kortixSessionId: session.session_id, title: clean };
    let threadId: Id<"threads">;
    for (let attempt = 1; ; attempt++) {
      try {
        threadId = await ctx.runMutation(internal.threads.record, recordArgs);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    return { threadId, kortixProjectId: a.kortixProjectId, kortixSessionId: session.session_id };
  },
});

/**
 * The caller's project-scoped Kortix token for one workspace. Called only by
 * the Next.js proxy (with the user's Better Auth JWT and LUMEN_PROXY_SECRET).
 * Membership is checked on every call; a stored token with >5 min left is reused.
 */
export const memberToken = action({
  // A string, not v.id: an unknown id from the browser bearer is a 404, not a validator error.
  args: { workspaceId: v.string(), proxySecret: v.string() },
  returns: v.object({
    token: v.string(),
    projectId: v.string(),
    expiresAt: v.number(),
    userId: v.string(),
    orgId: v.string(),
  }),
  handler: async (
    ctx,
    { workspaceId, proxySecret },
  ): Promise<{ token: string; projectId: string; expiresAt: number; userId: string; orgId: string }> => {
    requireProxy(proxySecret);
    const a = await ctx.runQuery(internal.workspaces.access, { workspaceId });
    const who = { projectId: a.kortixProjectId, userId: a.userId, orgId: a.orgId };
    const cached = await ctx.runQuery(internal.memberTokens.valid, { workspaceId: a.workspaceId, userId: a.userId });
    if (cached) return { token: cached.secret, expiresAt: cached.expiresAt, ...who };
    const minted = await mintScopedToken(ctx, `lumen-member-${a.userId}`, a.kortixProjectId, MEMBER_TOKEN_TTL_MS);
    await ctx.runMutation(internal.memberTokens.store, { workspaceId: a.workspaceId, orgId: a.orgId, userId: a.userId, ...minted });
    return { token: minted.secret, expiresAt: minted.expiresAt, ...who };
  },
});

export const revokeToken = internalAction({
  args: { tokenId: v.string() },
  returns: v.null(),
  handler: async (_ctx, { tokenId }) => {
    try {
      await operator().kortix.accounts.tokens.revoke(tokenId);
    } catch {
      // Already revoked or gone: an expired token is inert either way.
    }
    return null;
  },
});
