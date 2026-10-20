"use node";

// Every Kortix call Lumen makes with the operator credential. The credential
// lives only in Convex env (KORTIX_OPERATOR_TOKEN); Next.js and the browser
// never hold it. Members get short-lived project-scoped tokens minted here.

import { getProjectDrive, makeDriveFolder, updateAgentConfig, updateFeatureFlag, updateProjectDefaultAgent } from "@kortix/sdk";
import { createScopedKortix, runWithKortix } from "@kortix/sdk/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, action, internalAction } from "./_generated/server";
import { requireProxy } from "./access";
import { COUNSEL_AGENT, COUNSEL_PROMPT, FIRM_FOLDERS } from "./lumenAgent";
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

/** mkdir that treats "already exists" as done, so a re-run of provisioning is a no-op. */
async function ensureFolder(driveId: string, path: string) {
  try {
    await makeDriveFolder(driveId, path);
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
  }
}

/**
 * firm → one Kortix project (idempotent per firm), Lumen's counsel agent as
 * the project default, and the Drive folders Lumen keeps its files in.
 * Stage 2 replaces the single agent with the versioned agent kit.
 */
export const provisionFirm = internalAction({
  args: { firmId: v.id("firms") },
  returns: v.null(),
  handler: async (ctx, { firmId }) => {
    const row = await ctx.runQuery(internal.firms.forProvision, { firmId });
    if (!row || row.status !== "provisioning") return null;
    let kortixProjectId: string;
    let kortixDriveId: string;
    try {
      const { config, kortix } = operator();
      const project = await kortix.projects.provision({
        // Kortix project names allow letters, digits, spaces, `-`, `_` and `.` only ("Example & Co." has an `&`).
        name: `lumen-${row.name}`.replace(/[^A-Za-z0-9 _.-]+/g, "-").slice(0, 80),
        starter_template: "general-knowledge-worker",
        idempotency_key: `lumen-firm-${firmId}`,
      });
      kortixProjectId = project.project_id;
      // ponytail: agent config and Drive are not on the scoped facade yet (contract G1), so they run inside runWithKortix.
      kortixDriveId = await runWithKortix(config, async () => {
        await updateAgentConfig(kortixProjectId, COUNSEL_AGENT, {
          enabled: true,
          behavior: { mode: "primary", prompt: COUNSEL_PROMPT, ...(row.model ? { model: row.model } : {}) },
        });
        await updateProjectDefaultAgent(kortixProjectId, COUNSEL_AGENT);
        // Files (Drive) is behind the project's `volumes` flag; Lumen keeps matter files there.
        await updateFeatureFlag(kortixProjectId, "volumes", true);
        const drive = await getProjectDrive(kortixProjectId);
        for (const path of FIRM_FOLDERS) await ensureFolder(drive.driveId, path);
        return drive.driveId;
      });
    } catch (err) {
      const detail = String((err as Error)?.message ?? err).slice(0, 500);
      await ctx.runMutation(internal.firms.settle, { firmId, error: detail });
      return null;
    }
    // Outside the try: a failed settle is a Convex hiccup, not a failed Kortix
    // project, so it is retried. After the last attempt the firm is marked
    // failed; "Try again" re-runs this action and the idempotency key returns
    // the same project.
    for (let attempt = 1; ; attempt++) {
      try {
        await ctx.runMutation(internal.firms.settle, { firmId, kortixProjectId, kortixDriveId });
        break;
      } catch (err) {
        if (attempt === 3) {
          await ctx.runMutation(internal.firms.settle, { firmId, error: `settle: ${String((err as Error)?.message ?? err)}` });
          break;
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    return null;
  },
});

/** A member opens a thread in a matter: one Kortix session on Lumen's counsel agent, tagged with Lumen's ids. */
export const createThread = action({
  args: { matterId: v.id("matters"), title: v.string() },
  returns: v.object({ threadId: v.id("threads"), kortixProjectId: v.string(), kortixSessionId: v.string() }),
  handler: async (
    ctx,
    { matterId, title },
  ): Promise<{ threadId: Id<"threads">; kortixProjectId: string; kortixSessionId: string }> => {
    const a = await ctx.runQuery(internal.matters.access, { matterId });
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 120) || "New thread";
    const session = await operator().kortix.projects.createSession(a.kortixProjectId, {
      name: clean,
      agent_name: COUNSEL_AGENT,
      ...lumenSessionTags(a),
    });
    // The session exists now: retry the record (idempotent per session) so a
    // Convex hiccup does not leave a tagged session with no thread row.
    const recordArgs = {
      firmId: a.firmId, matterId: a.matterId, orgId: a.orgId, userId: a.userId, kortixSessionId: session.session_id, title: clean,
    };
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
 * The caller's project-scoped Kortix token for the firm that owns a matter.
 * Called only by the Next.js proxy (with the user's Better Auth JWT and
 * LUMEN_PROXY_SECRET). Matter access is checked on every call, so a
 * restricted matter is refused to a member who is not on it; a stored token
 * with >5 min left is reused.
 */
export const memberToken = action({
  // A string, not v.id: an unknown id from the browser bearer is a 404, not a validator error.
  args: { matterId: v.string(), proxySecret: v.string() },
  returns: v.object({
    token: v.string(),
    projectId: v.string(),
    expiresAt: v.number(),
    userId: v.string(),
    orgId: v.string(),
    firmId: v.string(),
  }),
  handler: async (
    ctx,
    { matterId, proxySecret },
  ): Promise<{ token: string; projectId: string; expiresAt: number; userId: string; orgId: string; firmId: string }> => {
    requireProxy(proxySecret);
    const a = await ctx.runQuery(internal.matters.access, { matterId });
    const who = { projectId: a.kortixProjectId, userId: a.userId, orgId: a.orgId, firmId: a.firmId };
    const cached = await ctx.runQuery(internal.memberTokens.valid, { firmId: a.firmId, userId: a.userId });
    if (cached) return { token: cached.secret, expiresAt: cached.expiresAt, ...who };
    const minted = await mintScopedToken(ctx, `lumen-member-${a.userId}`, a.kortixProjectId, MEMBER_TOKEN_TTL_MS);
    await ctx.runMutation(internal.memberTokens.store, { firmId: a.firmId, orgId: a.orgId, userId: a.userId, ...minted });
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
