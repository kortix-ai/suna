"use node";

// The engine's Kortix side. Each batch is one Kortix session on one Lumen
// agent with one input.json in Drive. The agent writes out/*.json and
// done.json into the same Drive folder; Convex polls the folder, validates each
// file against the kit's JSON Schemas (ajv), and hands it to runs.ingestResult,
// which checks every citation before a value reaches the UI. The browser is
// never in the loop: polling is Convex scheduled functions only.

import { createProjectSession, getSessionTurn, listDriveFolder, makeDriveFolder, readDriveFile, uploadDriveFile } from "@kortix/sdk";
import Ajv2020 from "ajv/dist/2020";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { KIT } from "./kit/bundle.generated";
import { ensureKit } from "./kitInstall";
import { RUNS_ROOT, sandboxPath } from "./lumenAgent";
import { asOperator, errorText, operator, sandboxProvider, withRetry } from "./operator";
import { LIMITS, NO_PROGRESS_MS, RUN_TIMEOUT_MS } from "./runs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const s of Object.values(KIT.schemas)) ajv.addSchema(s as object);
const SCHEMA_FOR_KIND: Record<string, string> = { review: "review-row", ask: "answer" };

/** Poll fast while a session boots and works, then slow down. */
const pollDelay = (startedAt: number | undefined) => (startedAt && Date.now() - startedAt < 2 * 60_000 ? 5_000 : 15_000);
/** A session gets this long after a prompt before Lumen reads an idle session as stopped. */
const PROMPT_GRACE_MS = 45_000;

const batchDir = (runId: string, batchId: string) => `${RUNS_ROOT}/${runId}/${batchId}`;

async function ensureFolder(driveId: string, path: string) {
  try {
    await makeDriveFolder(driveId, path);
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
  }
}

type Prep = {
  run: Doc<"runs">;
  firm: Doc<"firms">;
  matter: Doc<"matters">;
  columns: Doc<"reviews">["columns"] | null;
  batches: Doc<"runBatches">[];
  docs: Doc<"documents">[];
};

function inputFor(p: Prep, b: Doc<"runBatches">) {
  const docs = b.documentIds.map((id) => p.docs.find((d) => d._id === id)!).filter(Boolean);
  return {
    schema: "input/1",
    run_id: p.run._id,
    batch_id: b._id,
    kit_version: KIT.version,
    kind: p.run.kind,
    matter_dir: sandboxPath(p.matter.driveFolder),
    batch_dir: sandboxPath(batchDir(p.run._id, b._id)),
    documents: docs.map((d) => ({
      doc_id: d._id, filename: d.filename, text_path: sandboxPath(d.textFile!), original_path: sandboxPath(d.driveFile!),
    })),
    ...(p.columns ? { columns: p.columns } : {}),
    ...(p.run.question ? { question: p.run.question } : {}),
  };
}

/** queued → preparing (kit current, input.json per batch in Drive) → running. */
export const prepare = internalAction({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const p = (await ctx.runQuery(internal.runs.forPrepare, { runId })) as Prep | null;
    if (!p || !p.firm.kortixProjectId || !p.firm.kortixDriveId) {
      if (p) await ctx.runMutation(internal.runs.markRun, { runId, status: "failed", error: "The firm workspace is not ready" });
      return null;
    }
    if (!(await ctx.runMutation(internal.runs.markRun, { runId, status: "preparing", detail: "Checking the agent kit" }))) return null;
    const kitError = await ensureKit(ctx, p.firm._id);
    if (kitError) {
      await ctx.runMutation(internal.runs.markRun, { runId, status: "failed", error: "The agent kit could not be installed. Try again." });
      console.error(`[lumen] run ${runId}: kit: ${kitError}`);
      return null;
    }
    try {
      const driveId = p.firm.kortixDriveId;
      await asOperator(async () => {
        await ensureFolder(driveId, `${RUNS_ROOT}/${runId}`);
        for (const b of p.batches) {
          if (b.status !== "pending") continue;
          const dir = batchDir(runId, b._id);
          await ensureFolder(driveId, dir);
          const body = new TextEncoder().encode(JSON.stringify(inputFor(p, b), null, 1));
          await withRetry(() => uploadDriveFile(driveId, `${dir}/input.json`, body));
        }
      });
    } catch (err) {
      console.error(`[lumen] run ${runId}: prepare: ${errorText(err)}`);
      await ctx.runMutation(internal.runs.markRun, { runId, status: "failed", error: "Could not prepare the run. Try again." });
      return null;
    }
    if (await ctx.runMutation(internal.runs.markRun, { runId, status: "running", kitVersion: KIT.version, detail: `Agent kit ${KIT.version}` })) {
      await ctx.runMutation(internal.runs.schedule, { runId });
    }
    return null;
  },
});

const launchPrompt = (inputPath: string) =>
  `Run this Lumen batch now. Input: ${inputPath}\nRead it, do the task your instructions describe for its "kind", write every result with \`lumen result write\`, and finish with \`lumen result done\`.`;

async function startSession(b: Doc<"runBatches">, run: Doc<"runs">, firm: Doc<"firms">) {
  const session = await withRetry(() =>
    createProjectSession(firm.kortixProjectId!, {
      name: `${run.kind === "ask" ? "Ask" : "Review"}: ${run.title}`.slice(0, 120) + (run.kind === "review" ? ` (batch ${b.index + 1})` : ""),
      agent_name: b.agent,
      labels: [`lumen-firm:${firm._id}`, `lumen-matter:${run.matterId}`, `lumen-user:${run.createdBy}`, `lumen-run:${run._id}`].map((l) => l.slice(0, 64)),
      metadata: { lumen_firm_id: firm._id, lumen_matter_id: run.matterId, lumen_user_id: run.createdBy, lumen_run_id: run._id, lumen_batch_id: b._id },
      initial_prompt: launchPrompt(`${sandboxPath(batchDir(run._id, b._id))}/input.json`),
      ...sandboxProvider(),
    }),
  );
  return session.session_id;
}

/** starting → working: one Kortix session with the batch's input. */
export const launch = internalAction({
  args: { batchId: v.id("runBatches") },
  returns: v.null(),
  handler: async (ctx, { batchId }) => {
    const c = await ctx.runQuery(internal.runs.batchContext, { batchId });
    if (!c || c.batch.status !== "starting" || c.run.status !== "running") return null;
    try {
      const sid = await asOperator(() => startSession(c.batch, c.run, c.firm));
      const now = Date.now();
      const live = await ctx.runMutation(internal.runs.updateBatch, {
        batchId,
        patch: { status: "working", kortixSessionId: sid, startedAt: now, lastProgressAt: now, lastPromptAt: now },
        event: { type: "working", detail: `Batch ${c.batch.index + 1}: the agent is reading ${c.batch.documentIds.length} document${c.batch.documentIds.length === 1 ? "" : "s"}` },
      });
      if (live) await ctx.scheduler.runAfter(pollDelay(now), internal.engine.poll, { batchId });
      else await asOperator(() => stop(c.firm.kortixProjectId!, sid));
    } catch (err) {
      console.error(`[lumen] batch ${batchId}: launch: ${errorText(err)}`);
      await ctx.runMutation(internal.runs.settleBatch, { batchId, status: "failed", error: "The workspace could not start" });
    }
    return null;
  },
});

async function stop(projectId: string, sessionId: string) {
  const h = operator().kortix.session(projectId, sessionId);
  await h.abort().catch(() => undefined);
  await h.stop().catch(() => undefined);
}

export const stopSessions = internalAction({
  args: { runId: v.id("runs"), sessions: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { runId, sessions }) => {
    const p = (await ctx.runQuery(internal.runs.forPrepare, { runId })) as Prep | null;
    if (!p?.firm.kortixProjectId) return null;
    await asOperator(async () => {
      for (const sid of sessions) await stop(p.firm.kortixProjectId!, sid);
    });
    return null;
  },
});

type Listed = { path: string; version: string };

/** Every file under out/ (one level of folders: out/rows/), with a version that changes when the file does. */
async function listOutputs(driveId: string, dir: string): Promise<{ files: Listed[]; done: Listed | null }> {
  const list = async (path: string) => {
    try {
      return (await listDriveFolder(driveId, path)).entries;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return [];
      throw err;
    }
  };
  const top = await list(dir);
  const done = top.find((e) => e.name === "done.json" && e.type === "file");
  const files: Listed[] = [];
  const out = await list(`${dir}/out`);
  for (const e of out) {
    if (e.type === "dir") {
      for (const f of await list(`${dir}/out/${e.name}`)) {
        if (f.type === "file" && f.name.endsWith(".json")) files.push({ path: `out/${e.name}/${f.name}`, version: `${f.size}:${f.mtime}` });
      }
    } else if (e.type === "file" && e.name.endsWith(".json")) files.push({ path: `out/${e.name}`, version: `${e.size}:${e.mtime}` });
  }
  return { files, done: done ? { path: "done.json", version: `${done.size}:${done.mtime}` } : null };
}

async function readJson(driveId: string, path: string): Promise<unknown> {
  const { blob } = await withRetry(() => readDriveFile(driveId, path));
  return JSON.parse(await blob.text());
}

function schemaErrors(name: string, value: unknown): string[] {
  const validate = ajv.getSchema(name);
  if (!validate) return [`unknown schema ${name}`];
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || "$"} ${e.message ?? "is invalid"}`);
}

/** What the batch still owes: the documents with no accepted row, or the missing answer. */
function missing(c: { run: Doc<"runs">; batch: Doc<"runBatches"> }, accepted: Set<string>): string[] {
  if (c.run.kind === "ask") return accepted.has("out/answer.json") ? [] : ["out/answer.json"];
  return c.batch.documentIds.filter((id) => !accepted.has(`out/rows/${id}.json`)).map((id) => `out/rows/${id}.json`);
}

async function prompt(ctx: ActionCtx, c: { firm: Doc<"firms">; batch: Doc<"runBatches"> }, text: string) {
  await asOperator(() => operator().kortix.session(c.firm.kortixProjectId!, c.batch.kortixSessionId!).send(text, { agent: c.batch.agent }));
}

/**
 * One poll of a working batch: ingest new result files, then decide.
 * - invalid file or done.json with rows missing → repair prompt (≤ 2)
 * - session idle with no done.json → nudge prompt (≤ 2)
 * - session failed → a new session (≤ 1)
 * - 20 min with no new file, or 60 min for the run → failed
 */
export const poll = internalAction({
  args: { batchId: v.id("runBatches") },
  returns: v.null(),
  handler: async (ctx, { batchId }) => {
    const c = await ctx.runQuery(internal.runs.batchContext, { batchId });
    if (!c || c.batch.status !== "working" || c.run.status !== "running") return null;
    const { batch, run, firm } = c as { batch: Doc<"runBatches">; run: Doc<"runs">; firm: Doc<"firms"> };
    const seen = new Map<string, { version: string; status: string }>(c.files.map((f: { path: string; version: string; status: string }) => [f.path, f]));
    const dir = batchDir(run._id, batchId);
    const driveId = firm.kortixDriveId!;
    const settle = async (status: "succeeded" | "failed", error?: string) => {
      await ctx.runMutation(internal.runs.settleBatch, { batchId, status, error });
      // The work is in Drive and Convex: free the sandbox. Its transcript stays readable.
      await asOperator(() => stop(firm.kortixProjectId!, batch.kortixSessionId!)).catch(() => undefined);
    };
    const fail = (error: string) => settle("failed", error);
    const again = () => ctx.scheduler.runAfter(pollDelay(batch.startedAt), internal.engine.poll, { batchId });
    try {
      const { files, done } = await asOperator(() => listOutputs(driveId, dir));
      const rejected: string[] = [];
      for (const f of files) {
        // Each version is read once. A rejected file is reported once; the agent's next write is a new version.
        if (seen.get(f.path)?.version === f.version) continue;
        let value: unknown;
        try {
          value = await asOperator(() => readJson(driveId, `${dir}/${f.path}`));
        } catch {
          // A file caught mid-write: the next poll reads it again.
          continue;
        }
        const errors = schemaErrors(SCHEMA_FOR_KIND[run.kind], value);
        if (errors.length) {
          await ctx.runMutation(internal.runs.recordFile, { batchId, path: f.path, version: f.version, status: "rejected", errors });
          rejected.push(...errors.map((e) => `${f.path}: ${e}`));
          continue;
        }
        const problems = await ctx.runMutation(internal.runs.ingestResult, { batchId, path: f.path, version: f.version, value });
        rejected.push(...problems);
        seen.set(f.path, { version: f.version, status: "accepted" });
      }
      const accepted = new Set([...seen].filter(([, s]) => s.status === "accepted").map(([p]) => p));
      const owed = missing({ run, batch }, accepted);
      const now = Date.now();

      if (now - (run.startedAt ?? now) > RUN_TIMEOUT_MS) return void (await fail("The run took longer than 60 minutes"));
      if (now - (batch.lastProgressAt ?? now) > NO_PROGRESS_MS) return void (await fail("No progress for 20 minutes"));

      if (done && seen.get("done.json")?.version !== done.version) {
        const d = (await asOperator(() => readJson(driveId, `${dir}/done.json`)).catch(() => null)) as { status?: string; error?: string } | null;
        await ctx.runMutation(internal.runs.recordFile, { batchId, path: "done.json", version: done.version, status: "accepted" });
        if (d?.status === "failed" && owed.length === 0) return void (await settle("succeeded"));
        if (d?.status === "failed") return void (await fail(`The agent stopped: ${String(d.error ?? "no reason given").slice(0, 300)}`));
        if (owed.length === 0 && rejected.length === 0) {
          await ctx.runMutation(internal.runs.updateBatch, { batchId, patch: { status: "validating" }, event: { type: "validating", detail: `Batch ${batch.index + 1}: results checked` } });
          return void (await settle("succeeded"));
        }
        rejected.push(...owed.map((p) => `${p} is missing`));
      } else if (!done && owed.length === 0 && rejected.length === 0 && files.length > 0) {
        // Every result is in; done.json may still be on its way. Give it the grace period, then accept.
        if (now - (batch.lastProgressAt ?? now) > PROMPT_GRACE_MS) return void (await settle("succeeded"));
      }

      if (rejected.length) {
        if (batch.attempts.repair >= LIMITS.repair) return void (await fail(`Results stayed invalid after ${LIMITS.repair} repairs: ${rejected[0]}`));
        await prompt(ctx, c, `Lumen rejected these results. Fix each one, write the files again with \`lumen result write\`, then run \`lumen result done\` again:\n- ${rejected.slice(0, 12).join("\n- ")}`);
        await ctx.runMutation(internal.runs.updateBatch, {
          batchId, patch: { attempts: { ...batch.attempts, repair: batch.attempts.repair + 1 }, lastPromptAt: now, lastProgressAt: now },
          event: { type: "repair", detail: `Batch ${batch.index + 1}: asked the agent to fix ${rejected.length} problem${rejected.length === 1 ? "" : "s"}` },
        });
        await again();
        return null;
      }

      if (now - (batch.lastPromptAt ?? 0) > PROMPT_GRACE_MS) {
        const turn = await asOperator(() => getSessionTurn(firm.kortixProjectId!, batch.kortixSessionId!, { showErrors: false }));
        const ended = turn.last_ended?.ended_at ? Date.parse(turn.last_ended.ended_at) : 0;
        const idle = turn.turns.length === 0 && ended > (batch.lastPromptAt ?? 0);
        if (idle) {
          const failed = turn.last_ended?.error || turn.last_ended?.end_reason === "error";
          if (failed) {
            if (batch.attempts.relaunch >= LIMITS.relaunch) return void (await fail("The workspace failed twice"));
            const old = batch.kortixSessionId!;
            const sid = await asOperator(() => startSession(batch, run, firm));
            await asOperator(() => stop(firm.kortixProjectId!, old));
            await ctx.runMutation(internal.runs.updateBatch, {
              batchId,
              patch: { kortixSessionId: sid, attempts: { ...batch.attempts, relaunch: batch.attempts.relaunch + 1 }, lastPromptAt: now, lastProgressAt: now },
              event: { type: "relaunch", detail: `Batch ${batch.index + 1}: the workspace failed; started a new one` },
            });
          } else {
            if (batch.attempts.nudge >= LIMITS.nudge) return void (await fail(`The agent stopped before finishing: ${owed.length} result${owed.length === 1 ? "" : "s"} missing`));
            await prompt(ctx, c, `You stopped before the batch was finished. Still missing: ${owed.join(", ") || "done.json"}. Continue from where you are: write the missing results with \`lumen result write\`, then run \`lumen result done\`. Do not ask questions.`);
            await ctx.runMutation(internal.runs.updateBatch, {
              batchId, patch: { attempts: { ...batch.attempts, nudge: batch.attempts.nudge + 1 }, lastPromptAt: now },
              event: { type: "nudge", detail: `Batch ${batch.index + 1}: the agent paused; asked it to continue` },
            });
          }
        }
      }
    } catch (err) {
      // Network or Kortix errors after retries: keep polling; the no-progress timer bounds it.
      console.error(`[lumen] batch ${batchId}: poll: ${errorText(err)}`);
    }
    await again();
    return null;
  },
});
