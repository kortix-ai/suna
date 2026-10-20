"use node";

// Install or upgrade Lumen's agent kit in a firm's Kortix project, through the SDK only:
// 1. skills + the `lumen` tool CLI: one short session writes the files, commits,
//    opens a change request and merges it into the default branch;
// 2. the four agents: one agent-config commit each, then lumen-counsel as default.
// Running sessions keep the kit they started with; the next session gets the new one.

import { createProjectSession, mergeChangeRequest, openChangeRequest, updateAgentConfig, updateProjectDefaultAgent } from "@kortix/sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { KIT } from "./kit/bundle.generated";
import { AGENT_SKILLS, COUNSEL_AGENT } from "./lumenAgent";
import { asOperator, errorText, operator, sandboxProvider, withRetry } from "./operator";

/** Unattended runs have nobody to answer a permission prompt: the sandbox is the wall, web fetch stays off. */
const RUN_PERMISSION = { edit: "allow", bash: "allow", webfetch: "deny", external_directory: "allow" } as const;

async function installFiles(projectId: string) {
  const { kortix } = operator();
  const session = await withRetry(() =>
    createProjectSession(projectId, {
      name: `Lumen setup ${KIT.version}`,
      labels: ["lumen-kit-install"],
      metadata: { lumen_kit_version: KIT.version, lumen_kit_hash: KIT.hash },
      ...sandboxProvider(),
    }),
  );
  const h = kortix.session(projectId, session.session_id);
  try {
    // Skills from an older kit that this one no longer ships are removed, so no agent loads them.
    const shipped = new Set(KIT.files.filter((f) => f.path.startsWith("skills/")).map((f) => f.path.split("/")[1]));
    const existing = (await h.files.list("/workspace/skills").catch(() => [])) as Array<{ name: string; type: string }>;
    for (const e of existing) {
      if (e.type === "directory" && e.name.startsWith("lumen-") && !shipped.has(e.name)) await h.files.remove(`/workspace/skills/${e.name}`);
    }
    // ponytail: stale files under lumen-kit/ stay (the CLI imports only its known modules); clear the folder if that changes.
    for (const f of KIT.files) await withRetry(() => h.files.write(`/workspace/${f.path}`, new Blob([f.content])));
    const commit = await withRetry(() => h.commit({ message: `lumen kit ${KIT.version} (${KIT.hash})` }));
    if (commit.nothing_to_do || !commit.branch) return;
    const cr = await withRetry(() =>
      openChangeRequest(projectId, { title: `Lumen agent kit ${KIT.version}`, head_ref: commit.branch!, session_id: session.session_id }),
    );
    await withRetry(() => mergeChangeRequest(projectId, cr.cr_id, { message: `lumen kit ${KIT.version}` }));
  } finally {
    await h.delete().catch(() => undefined);
  }
}

async function installAgents(projectId: string, model: string | undefined) {
  for (const [name, prompt] of Object.entries(KIT.agents)) {
    await withRetry(() =>
      updateAgentConfig(projectId, name, {
        enabled: true,
        skills: [...(AGENT_SKILLS[name] ?? ["lumen-citations"])],
        kortix_permissions: "none",
        repository_access: true,
        behavior: { mode: "primary", prompt, permission: { ...RUN_PERMISSION }, ...(model ? { model } : {}) },
      }),
    );
  }
  await withRetry(() => updateProjectDefaultAgent(projectId, COUNSEL_AGENT));
}

/** Install when the firm is behind. Returns the error text, or null when the kit is current. */
export async function ensureKit(ctx: ActionCtx, firmId: Id<"firms">, waitMs = 180_000): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const s = await ctx.runQuery(internal.kit.state, { firmId });
    if (s.current) return null;
    if (!s.kortixProjectId) return "the firm workspace is not ready";
    const installId = await ctx.runMutation(internal.kit.claim, { firmId });
    if (installId) {
      const t0 = Date.now();
      try {
        await asOperator(async () => {
          await installFiles(s.kortixProjectId!);
          await installAgents(s.kortixProjectId!, s.model);
        });
        await ctx.runMutation(internal.kit.settle, { installId });
        console.log(`[lumen] kit ${KIT.version} installed for ${firmId} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        return null;
      } catch (err) {
        await ctx.runMutation(internal.kit.settle, { installId, error: errorText(err) });
        return errorText(err);
      }
    }
    if (Date.now() > deadline) return s.lastError ?? "the agent kit install did not finish";
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export const ensure = internalAction({
  args: { firmId: v.id("firms") },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { firmId }) => ensureKit(ctx, firmId),
});
