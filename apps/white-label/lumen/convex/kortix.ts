"use node";

// Every Kortix call that sets up Lumen's one project and its firms, plus the
// thread create and the proxy's credential lookup.
//
// One Kortix project serves every firm. The firm boundary is three Kortix
// primitives per firm (README "One project, many firms"):
// - folder /Lumen/Firms/<firmId>, shared `write` with the firm's agent only;
// - agent lumen-f-<firmId>: kortix_permissions none, no repository, grants =
//   its firm folder (write) + /Lumen/Kit (read). A session mounts what its
//   agent's grants reach and nothing else;
// - service account lumen-firm-<firmId>, project role `member`: it creates and
//   drives the firm's sessions. Kortix keeps a session private to its creator,
//   so another firm's credential gets 404 on it, its transcript and its sandbox.

import {
  createAssignment,
  createProjectSession,
  createServiceAccountApi,
  deleteServiceAccountApi,
  getFolderAccess,
  getProject,
  getProjectDetail,
  getProjectDrive,
  listServiceAccountsApi,
  moveDriveFile,
  shareFolder,
  unshareFolder,
  updateAgentConfig,
  updateFeatureFlag,
  updateProjectDefaultAgent,
  uploadDriveFile,
} from "@kortix/sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, action, internalAction } from "./_generated/server";
import { requireProxy } from "./access";
import type { FirmContext } from "./deployment";
import { KIT } from "./kit/bundle.generated";
import {
  COUNSEL_ROLE, FIRMS_ROOT, FIRM_ROOT, KIT_CURRENT, KIT_ROOT, LUMEN_ROOT, NONE_AGENT, RUNS_ROOT, WALLED_ROOT, firmAgent, firmFolders,
  firmServiceAccount, matterAgent,
} from "./lumenAgent";
import { asFirm, asOperator, ensureFolder, errorText, operator, sandboxProvider, withRetry } from "./operator";
import { lumenSessionTags } from "./tags";

/** Unattended runs have nobody to answer a permission prompt: the sandbox is the wall, web fetch stays off. */
const RUN_PERMISSION = { edit: "allow", bash: "allow", webfetch: "deny", external_directory: "allow" } as const;

/** How long the proxy may cache the firm credential it gets back (the access check runs again after it). */
const CREDENTIAL_CACHE_MS = 60 * 60_000;

type Deployment = { projectId: string; accountId: string; driveId: string; kitVersion: string };

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Create or upgrade the shared project, idempotently: the project
 * (KORTIX_PROJECT_ID, else one provisioned with a fixed idempotency key),
 * Files on, the default "/Company for everyone" grant removed, the /Lumen
 * folders, the `lumen-none` default agent, then the kit at /Lumen/Kit/<version>/
 * and /Lumen/Kit/CURRENT.
 */
async function bootstrap(known: { projectId?: string; accountId?: string; driveId?: string }) {
  const { kortix } = operator();
  const projectId =
    known.projectId ??
    process.env.KORTIX_PROJECT_ID ??
    (await withRetry(() => kortix.projects.provision({ name: "lumen", idempotency_key: "lumen-deployment" }))).project_id;
  return await asOperator(async () => {
    const accountId = known.accountId ?? (await withRetry(() => getProject(projectId))).account_id;
    await withRetry(() => updateFeatureFlag(projectId, "volumes", true));
    const driveId = known.driveId ?? (await withRetry(() => getProjectDrive(projectId))).driveId;
    // /Company is shared with the whole project by default and so mounts in every
    // session. In a project of many firms nothing may reach every session.
    const company = await withRetry(() => getFolderAccess(driveId, "/Company")).catch(() => null);
    for (const g of company?.grants ?? []) {
      if (g.principalType === "project" && !g.inherited) await withRetry(() => unshareFolder(driveId, g.grantId));
    }
    for (const p of [LUMEN_ROOT, KIT_ROOT, FIRMS_ROOT, WALLED_ROOT]) await ensureFolder(driveId, p);
    await withRetry(() =>
      updateAgentConfig(projectId, NONE_AGENT, {
        enabled: true,
        kortix_permissions: "none",
        repository_access: false,
        behavior: { mode: "primary", description: "Lumen's default: no folders, no repository.", prompt: "This workspace has no documents. Say so and stop.", permission: { edit: "deny", bash: "deny", webfetch: "deny" } },
      }),
    );
    await withRetry(() => updateProjectDefaultAgent(projectId, NONE_AGENT));
    // The project's starter agents (a general agent with every permission and the
    // repository, a reflector that reads every session) do not belong in a
    // project of many firms: each is disabled and locked down.
    const detail = await withRetry(() => getProjectDetail(projectId));
    for (const a of detail.config.agents ?? []) {
      const locked = a.enabled === false && Array.isArray(a.scope?.kortix_permissions) && a.scope.kortix_permissions.length === 0;
      if (a.name.startsWith("lumen-") || a.platform || locked) continue;
      await withRetry(() =>
        updateAgentConfig(projectId, a.name, {
          enabled: false, kortix_permissions: "none", connectors: "none", secrets: "none", skills: "none", repository_access: false,
        }),
      );
    }
    // The kit: once per version, read-only for every firm agent. A running session keeps the version it started with.
    for (const f of KIT.files) {
      await withRetry(() => uploadDriveFile(driveId, `${KIT_ROOT}/${KIT.version}/${f.path}`, enc(f.content)));
    }
    await withRetry(() => uploadDriveFile(driveId, KIT_CURRENT, enc(`${KIT.version}\n`)));
    return { projectId, accountId, driveId };
  });
}

/** The shared project, ready with this code's kit. Single-flight across actions; waits for another bootstrap. */
export async function ensureDeployment(ctx: ActionCtx, waitMs = 240_000): Promise<Deployment> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ready = await ctx.runQuery(internal.deployment.state, {});
    if (ready) return ready;
    const c = await ctx.runMutation(internal.deployment.claim, {});
    if (c.outcome === "claimed") {
      const t0 = Date.now();
      let ids: Awaited<ReturnType<typeof bootstrap>>;
      try {
        ids = await bootstrap(c);
      } catch (err) {
        await ctx.runMutation(internal.deployment.settle, { projectId: c.projectId, accountId: c.accountId, driveId: c.driveId, error: errorText(err) });
        throw err;
      }
      await ctx.runMutation(internal.deployment.settle, { ...ids, kitVersion: KIT.version, kitHash: KIT.hash });
      console.log(`[lumen] deployment ${ids.projectId} ready with kit ${KIT.version} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      continue;
    }
    if (c.outcome === "busy" && Date.now() > deadline) throw new Error("503: the Lumen workspace is still being set up");
    if (c.outcome === "busy") await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Operator entry point (`npx convex run kortix:ensure`): create or upgrade the shared project now. Onboarding also calls it. */
export const ensure = internalAction({
  args: {},
  returns: v.object({ projectId: v.string(), accountId: v.string(), driveId: v.string(), kitVersion: v.string() }),
  handler: async (ctx) => await ensureDeployment(ctx),
});

/** The config version a firm agent was written with: the kit hash and the firm's model. */
const agentConfigKey = (model: string | undefined) => `${KIT.hash}:${model ?? ""}`;

/** The firm's agent: the counsel prompt; a run names its role file in input.json. No skills, no repository, no Kortix permissions. */
async function writeFirmAgent(projectId: string, agent: string, model: string | undefined) {
  await withRetry(() =>
    updateAgentConfig(projectId, agent, {
      enabled: true,
      kortix_permissions: "none",
      repository_access: false,
      behavior: {
        mode: "primary",
        description: "Answers questions about the matter's documents, with citations.",
        prompt: KIT.agents[COUNSEL_ROLE], permission: { ...RUN_PERMISSION }, ...(model ? { model } : {}) },
    }),
  );
}

/** Rewrite a firm's agent when the kit or the firm's model changed since it was written. */
export async function ensureFirmAgent(ctx: ActionCtx, f: FirmContext) {
  const key = agentConfigKey(f.model);
  if (f.agentConfig === key) return;
  await asOperator(() => writeFirmAgent(f.projectId, f.agent, f.model));
  await ctx.runMutation(internal.deployment.markAgent, { firmId: f.firmId, kortixAgent: f.agent, agentConfig: key });
}

/** The firm's service account with project role `member`. A leftover with no stored secret is deleted first. */
async function createFirmServiceAccount(d: Deployment, firmId: string, agent: string) {
  const name = firmServiceAccount(firmId);
  for (const old of await withRetry(() => listServiceAccountsApi(d.accountId))) {
    if (old.name === name) await deleteServiceAccountApi(d.accountId, old.service_account_id).catch(() => undefined);
  }
  const sa = await createServiceAccountApi(d.accountId, { name, description: "Lumen: creates and drives this firm's sessions" });
  const principal = { type: "service_account" as const, id: sa.service_account_id };
  await withRetry(() => createAssignment(d.accountId, { principal, roleKey: "member", scope: { type: "project", id: d.projectId } }));
  // The firm's agent, as an object grant. Kortix does not filter agents for a
  // service account today (any agent runs), so Lumen pins agent_name too.
  await withRetry(() =>
    createAssignment(d.accountId, { principal, roleKey: "agent-user", scope: { type: "project", id: d.projectId }, object: { type: "agent", id: agent } }),
  );
  return sa;
}

/**
 * Onboard a firm into the shared project (idempotent): its folders, its agent
 * with two folder grants, and its service account. A failure marks the firm
 * failed with generic text; "Try again" re-runs every step.
 */
export const provisionFirm = internalAction({
  args: { firmId: v.id("firms") },
  returns: v.null(),
  handler: async (ctx, { firmId }) => {
    const row = await ctx.runQuery(internal.firms.forProvision, { firmId });
    if (!row || row.status !== "provisioning") return null;
    const agent = firmAgent(firmId);
    try {
      const t0 = Date.now();
      const d = await ensureDeployment(ctx);
      await asOperator(async () => {
        for (const p of firmFolders(firmId)) await ensureFolder(d.driveId, p);
        await writeFirmAgent(d.projectId, agent, row.model);
        await withRetry(() => shareFolder(d.driveId, { path: FIRM_ROOT(firmId), principalType: "agent", principalId: agent, level: "write" }));
        await withRetry(() => shareFolder(d.driveId, { path: KIT_ROOT, principalType: "agent", principalId: agent, level: "read" }));
      });
      await ctx.runMutation(internal.deployment.markAgent, { firmId, kortixAgent: agent, agentConfig: agentConfigKey(row.model) });
      if (!(await ctx.runQuery(internal.deployment.credential, { firmId }))) {
        const sa = await asOperator(() => createFirmServiceAccount(d, firmId, agent));
        await withConvexRetry(() => ctx.runMutation(internal.deployment.storeCredential, { firmId, serviceAccountId: sa.service_account_id, secret: sa.secret }));
      }
      console.log(`[lumen] firm ${firmId} onboarded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      await ctx.runMutation(internal.firms.settle, { firmId, error: errorText(err) });
      return null;
    }
    await withConvexRetry(() => ctx.runMutation(internal.firms.settle, { firmId })).catch(async (err) => {
      await ctx.runMutation(internal.firms.settle, { firmId, error: `settle: ${errorText(err)}` });
    });
    return null;
  },
});

const statusOf = (err: unknown) => (err as { status?: number })?.status;

/** Move a Drive folder. Already moved (the source is gone, the destination exists) counts as done, so a retry resumes. */
async function moveFolder(driveId: string, from: string, to: string) {
  try {
    await withRetry(() => moveDriveFile(driveId, from, to));
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
    await ensureFolder(driveId, to);
  }
}

/**
 * Put a matter's Drive folder where its visibility says (convex/lumenAgent.ts
 * `matterFolder`), after a create or a visibility change:
 * - restricted: the folder moves to /Lumen/Walled/<matterId>, outside the firm
 *   folder every firm session mounts, with the matter's earlier run folders.
 *   The matter gets its own agent, lumen-m-<matterId>, whose only grants are
 *   that folder (write) and the kit (read). Sessions of the matter run on it.
 * - firm: the folder moves back into the firm folder; sessions run on the firm agent.
 * Until it is done, no thread, run or upload of the matter starts. Retried 5 times;
 * after that the matter stays where it was (a restricted matter then refuses
 * new sessions: fail closed).
 */
export const placeMatter = internalAction({
  args: { matterId: v.id("matters"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { matterId, attempt = 1 }) => {
    const p = (await ctx.runQuery(internal.matters.forPlacement, { matterId })) as {
      matter: Doc<"matters">; target: string; runs: Array<{ runId: Id<"runs">; driveDir: string | null }>;
    } | null;
    if (!p?.matter.folderMoving) return null;
    const m = p.matter;
    const from = m.driveFolder;
    const to = p.target;
    try {
      const d = await ensureDeployment(ctx);
      const f = await firmReady(ctx, m.firmId);
      const runDirs: Array<{ runId: Id<"runs">; driveDir: string }> = [];
      let agent: string | undefined;
      await asOperator(async () => {
        await ensureFolder(f.driveId, WALLED_ROOT);
        if (from && from !== to) await moveFolder(f.driveId, from, to);
        else await ensureFolder(f.driveId, to);
        for (const r of p.runs) {
          // A run folder inside the matter folder moved with it.
          if (r.driveDir && from && r.driveDir.startsWith(`${from}/`)) runDirs.push({ runId: r.runId, driveDir: `${to}${r.driveDir.slice(from.length)}` });
        }
        if (m.visibility !== "restricted") return;
        // Earlier runs of the matter kept their folders in the firm's Runs folder: they hold
        // excerpts of the matter's documents, so they move into the walled folder too.
        await ensureFolder(f.driveId, `${to}/Runs`);
        for (const r of p.runs) {
          if (runDirs.some((x) => x.runId === r.runId)) continue;
          const old = r.driveDir ?? `${RUNS_ROOT(m.firmId)}/${r.runId}`;
          const dest = `${to}/Runs/${r.runId}`;
          if (old === dest) continue;
          await moveFolder(f.driveId, old, dest);
          runDirs.push({ runId: r.runId, driveDir: dest });
        }
        agent = matterAgent(matterId);
        await writeFirmAgent(f.projectId, agent, f.model);
        // Sharing again only sets the level, so a retry is a no-op.
        await withRetry(() => shareFolder(f.driveId, { path: to, principalType: "agent", principalId: agent!, level: "write" }));
        await withRetry(() => shareFolder(f.driveId, { path: KIT_ROOT, principalType: "agent", principalId: agent!, level: "read" }));
        const cred = await ctx.runQuery(internal.deployment.credential, { firmId: m.firmId });
        if (cred) {
          const principal = { type: "service_account" as const, id: cred.serviceAccountId };
          await withRetry(() =>
            createAssignment(d.accountId, { principal, roleKey: "agent-user", scope: { type: "project", id: d.projectId }, object: { type: "agent", id: agent! } }),
          ).catch((err) => {
            if (statusOf(err) !== 409) throw err;
          });
        }
      });
      await withConvexRetry(() =>
        ctx.runMutation(internal.matters.placed, {
          matterId, from, to, runDirs, ...(agent ? { kortixAgent: agent, agentConfig: agentConfigKey(f.model) } : {}),
        }),
      );
      console.log(`[lumen] matter ${matterId} placed at ${to}${agent ? ` on ${agent}` : ""}`);
    } catch (err) {
      console.error(`[lumen] matter ${matterId}: placement attempt ${attempt}: ${errorText(err)}`);
      if (attempt < 5) await ctx.scheduler.runAfter(15_000 * attempt, internal.kortix.placeMatter, { matterId, attempt: attempt + 1 });
      else await ctx.runMutation(internal.matters.placementFailed, { matterId });
    }
    return null;
  },
});

/** Operator entry point (`npx convex run kortix:placeRestricted`): give every restricted matter on the old layout its own folder and agent. */
export const placeRestricted = internalAction({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const ids: Id<"matters">[] = await ctx.runQuery(internal.matters.unplaced, {});
    for (const matterId of ids) await ctx.runMutation(internal.matters.startPlacement, { matterId });
    return ids.length;
  },
});

/** Rewrite a restricted matter's agent when the kit or the firm's model changed since it was written. */
export async function ensureMatterAgent(ctx: ActionCtx, f: FirmContext, m: { matterId: Id<"matters">; agent: string; agentConfig?: string }) {
  if (m.agent === f.agent) return;
  const key = agentConfigKey(f.model);
  if (m.agentConfig === key) return;
  await asOperator(() => writeFirmAgent(f.projectId, m.agent, f.model));
  await ctx.runMutation(internal.matters.markMatterAgent, { matterId: m.matterId, agentConfig: key });
}

/** A Convex write after a Kortix side effect: retried, so a hiccup does not orphan what Kortix already made. */
async function withConvexRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

/** The firm's credential and agent, current with this code's kit. Throws 409 while the firm is not onboarded. */
export async function firmReady(ctx: ActionCtx, firmId: Id<"firms">): Promise<FirmContext> {
  await ensureDeployment(ctx);
  const f = await ctx.runQuery(internal.deployment.firmContext, { firmId });
  if (!f) throw new Error("409: the firm workspace is still being set up");
  await ensureFirmAgent(ctx, f);
  return f;
}

/** A thread title of at most 120 characters, cut at a word with "…"; the UI truncates further with CSS. */
function shortTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= 120) return t;
  const cut = t.slice(0, 119);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 60 ? cut.lastIndexOf(" ") : 119).replace(/[\s,;:.-]+$/, "")}…`;
}

/** A member opens a thread in a matter: one session on the firm's agent, created by the firm's service account, tagged with Lumen's ids. */
export const createThread = action({
  // `prompt`: the opening question. Kortix queues it with the session (create
  // `pending_prompt`), so it runs as the first turn and never shows in the
  // composer's queued list.
  args: { matterId: v.id("matters"), title: v.string(), prompt: v.optional(v.string()) },
  returns: v.object({ threadId: v.id("threads"), kortixProjectId: v.string(), kortixSessionId: v.string() }),
  handler: async (
    ctx,
    { matterId, title, prompt },
  ): Promise<{ threadId: Id<"threads">; kortixProjectId: string; kortixSessionId: string }> => {
    const a = await ctx.runQuery(internal.matters.access, { matterId });
    const clean = shortTitle(title) || "New thread";
    const f = await firmReady(ctx, a.firmId);
    await ensureMatterAgent(ctx, f, { matterId: a.matterId, agent: a.agent, agentConfig: a.agentConfig });
    const session = await asFirm(f.secret, () =>
      withRetry(() =>
        createProjectSession(f.projectId, {
          name: clean,
          agent_name: a.agent,
          ...(prompt?.trim() ? { pending_prompt: { text: prompt.trim() } } : {}),
          ...sandboxProvider(),
          ...lumenSessionTags(a),
        }),
      ),
    );
    // The session exists now: retry the record (idempotent per session) so a
    // Convex hiccup does not leave a tagged session with no thread row.
    const threadId = await withConvexRetry(() =>
      ctx.runMutation(internal.threads.record, {
        firmId: a.firmId, matterId: a.matterId, orgId: a.orgId, userId: a.userId, kortixSessionId: session.session_id, title: clean,
      }),
    );
    return { threadId, kortixProjectId: f.projectId, kortixSessionId: session.session_id };
  },
});

/**
 * The firm's Kortix credential (its service-account secret) and agent, for the
 * firm that owns a matter. Called only by the Next.js proxy (with the user's
 * Better Auth JWT and LUMEN_PROXY_SECRET). Matter access is checked on every
 * call, so a restricted matter is refused to a member who is not on it. The
 * secret reaches only the Next.js server, never a response body.
 */
export const memberToken = action({
  // A string, not v.id: an unknown id from the browser bearer is a 404, not a validator error.
  args: { matterId: v.string(), proxySecret: v.string() },
  returns: v.object({
    token: v.string(),
    projectId: v.string(),
    agent: v.string(),
    matterDir: v.string(),
    expiresAt: v.number(),
    userId: v.string(),
    orgId: v.string(),
    firmId: v.string(),
  }),
  handler: async (
    ctx,
    { matterId, proxySecret },
  ): Promise<{ token: string; projectId: string; agent: string; matterDir: string; expiresAt: number; userId: string; orgId: string; firmId: string }> => {
    requireProxy(proxySecret);
    const a = await ctx.runQuery(internal.matters.access, { matterId });
    const f = await ctx.runQuery(internal.deployment.firmContext, { firmId: a.firmId });
    if (!f) throw new Error("409: the firm workspace is still being set up");
    // The agent and folder are the matter's: a restricted matter runs on its own agent.
    return {
      token: f.secret, projectId: f.projectId, agent: a.agent, matterDir: a.matterDir, expiresAt: Date.now() + CREDENTIAL_CACHE_MS,
      userId: a.userId, orgId: a.orgId, firmId: a.firmId,
    };
  },
});
