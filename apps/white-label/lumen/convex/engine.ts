"use node";

// The engine's Kortix side. Each batch is one Kortix session on the firm's
// agent, created and driven by the firm's service account, with one input.json
// (naming the kit role to play) in the firm's Drive folder. The agent writes out/*.json and
// done.json into the same Drive folder; Convex polls the folder, validates each
// file against the kit's JSON Schemas (ajv), and hands it to runs.ingestResult,
// which checks every citation before a value reaches the UI. The browser is
// never in the loop: polling is Convex scheduled functions only.

import { createProjectSession, getSessionTurn, listDriveFolder, readDriveFile, uploadDriveFile } from "@kortix/sdk";
import Ajv2020 from "ajv/dist/2020";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import type { FirmContext } from "./deployment";
import { KIT } from "./kit/bundle.generated";
import { firmReady } from "./kortix";
import { RUNS_ROOT, sandboxPath } from "./lumenAgent";
import { asFirm, asOperator, errorText, firmClient, sandboxProvider, withRetry, ensureFolder } from "./operator";
import { LIMITS, NO_PROGRESS_MS, RUN_TIMEOUT_MS, inputKind, resultContract } from "./runs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const s of Object.values(KIT.schemas)) ajv.addSchema(s as object);

/** Poll fast while a session boots and works, then slow down. */
const pollDelay = (startedAt: number | undefined) => (startedAt && Date.now() - startedAt < 2 * 60_000 ? 5_000 : 15_000);
/** A session gets this long after a prompt before Lumen reads an idle session as stopped. */
const PROMPT_GRACE_MS = 45_000;

const batchDir = (firmId: string, runId: string, batchId: string) => `${RUNS_ROOT(firmId)}/${runId}/${batchId}`;

type Prep = {
  run: Doc<"runs">;
  firm: Doc<"firms">;
  matter: Doc<"matters">;
  columns: Doc<"reviews">["columns"] | null;
  batches: Doc<"runBatches">[];
  docs: Doc<"documents">[];
  library: { name: string; body: string } | null;
};

/** The firm's playbook or template, copied into the batch folder at start: the run reads the version it started with. */
const libraryFile = (kind: string) => (kind === "contract_review" ? "in/playbook.md" : "in/template.md");

function inputFor(p: Prep, b: Doc<"runBatches">) {
  const docs = b.documentIds.map((id) => p.docs.find((d) => d._id === id)!).filter(Boolean);
  const dir = sandboxPath(batchDir(p.run.firmId, p.run._id, b._id));
  const kind = p.run.kind;
  return {
    schema: "input/1",
    run_id: p.run._id,
    batch_id: b._id,
    kit_version: KIT.version,
    kind: inputKind(kind, b.phase),
    role: b.role,
    role_path: `${KIT.dir}/agents/${b.role}.md`,
    matter_dir: sandboxPath(p.matter.driveFolder),
    batch_dir: dir,
    documents: docs.map((d) => ({
      doc_id: d._id, filename: d.filename, text_path: sandboxPath(d.textFile!), original_path: sandboxPath(d.driveFile!),
    })),
    ...(p.columns && b.phase !== "reduce" ? { columns: p.columns } : {}),
    ...(p.run.question ? { question: p.run.question } : {}),
    ...(kind === "contract_review" ? { playbook_path: `${dir}/${libraryFile(kind)}`, perspective: p.run.perspective ?? "our client" } : {}),
    ...(kind === "draft" ? { template_path: `${dir}/${libraryFile(kind)}`, fields: p.run.fields ?? {} } : {}),
    ...(b.phase === "reduce" ? { rows_dir: `${dir}/in/rows` } : {}),
  };
}

/** queued → preparing (kit current, input.json per batch in Drive) → running. */
export const prepare = internalAction({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const p = (await ctx.runQuery(internal.runs.forPrepare, { runId })) as Prep | null;
    if (p && (p.run.kind === "contract_review" || p.run.kind === "draft") && !p.library) {
      await ctx.runMutation(internal.runs.markRun, { runId, status: "failed", error: "The playbook or template was deleted" });
      return null;
    }
    if (!p) return null;
    if (!(await ctx.runMutation(internal.runs.markRun, { runId, status: "preparing", detail: "Checking the agent kit" }))) return null;
    let f: FirmContext;
    try {
      f = await firmReady(ctx, p.firm._id);
    } catch (err) {
      await ctx.runMutation(internal.runs.markRun, { runId, status: "failed", error: "The firm workspace is not ready. Try again." });
      console.error(`[lumen] run ${runId}: firm: ${errorText(err)}`);
      return null;
    }
    try {
      const driveId = f.driveId;
      await asOperator(async () => {
        await ensureFolder(driveId, `${RUNS_ROOT(p.run.firmId)}/${runId}`);
        for (const b of p.batches) {
          if (b.status !== "pending") continue;
          const dir = batchDir(p.run.firmId, runId, b._id);
          await ensureFolder(driveId, dir);
          const body = new TextEncoder().encode(JSON.stringify(inputFor(p, b), null, 1));
          await withRetry(() => uploadDriveFile(driveId, `${dir}/input.json`, body));
          if (p.library) {
            await ensureFolder(driveId, `${dir}/in`);
            const md = new TextEncoder().encode(p.library.body);
            await withRetry(() => uploadDriveFile(driveId, `${dir}/${libraryFile(p.run.kind)}`, md));
          }
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
  `Run this Lumen batch now. Input: ${inputPath}\nRead it, then read its \`role_path\` file in full: those are your instructions for this run. Do the task they describe for its "kind", write every result with \`lumen result write\`, and finish with \`lumen result done\`.`;

const KIND_NAME: Record<string, string> = {
  review: "Review", column: "Review", ask: "Ask", contract_review: "Contract review", diligence: "Due diligence", draft: "Draft",
};

/** A reduce batch reads the checklist rows Lumen accepted: Convex writes them into the batch folder, never the map agents. */
async function writeReduceRows(ctx: ActionCtx, run: Doc<"runs">, b: Doc<"runBatches">, driveId: string) {
  const rows = await ctx.runQuery(internal.runs.reduceRows, { runId: run._id });
  const dir = `${batchDir(run.firmId, run._id, b._id)}/in/rows`;
  await ensureFolder(driveId, `${batchDir(run.firmId, run._id, b._id)}/in`);
  await ensureFolder(driveId, dir);
  for (const r of rows) {
    await withRetry(() => uploadDriveFile(driveId, `${dir}/${r.docId}.json`, new TextEncoder().encode(JSON.stringify(r.row, null, 1))));
  }
  return rows.length;
}

/** One session for the batch, as the firm's service account, on the firm's agent (its mounts: the firm folder and the kit). */
async function startSession(b: Doc<"runBatches">, run: Doc<"runs">, f: FirmContext) {
  const session = await asFirm(f.secret, () =>
    withRetry(() =>
      createProjectSession(f.projectId, {
        name: `${KIND_NAME[run.kind] ?? "Run"}: ${run.title}`.slice(0, 110) + (b.phase === "reduce" ? " (report)" : run.documentIds.length > 4 && b.role === "lumen-extractor" ? ` (batch ${b.index + 1})` : ""),
        agent_name: f.agent,
        labels: [`lumen-firm:${run.firmId}`, `lumen-matter:${run.matterId}`, `lumen-user:${run.createdBy}`, `lumen-run:${run._id}`].map((l) => l.slice(0, 64)),
        metadata: { lumen_firm_id: run.firmId, lumen_matter_id: run.matterId, lumen_user_id: run.createdBy, lumen_run_id: run._id, lumen_batch_id: b._id },
        initial_prompt: launchPrompt(`${sandboxPath(batchDir(run.firmId, run._id, b._id))}/input.json`),
        ...sandboxProvider(),
      }),
    ),
  );
  return session.session_id;
}

/** The firm's credential, project and Drive, or null when the firm is not onboarded. */
const firmOf = (ctx: ActionCtx, firmId: Doc<"firms">["_id"]) => ctx.runQuery(internal.deployment.firmContext, { firmId });

/** starting → working: one Kortix session with the batch's input. */
export const launch = internalAction({
  args: { batchId: v.id("runBatches") },
  returns: v.null(),
  handler: async (ctx, { batchId }) => {
    const c = await ctx.runQuery(internal.runs.batchContext, { batchId });
    if (!c || c.batch.status !== "starting" || c.run.status !== "running") return null;
    try {
      const f = await firmOf(ctx, c.run.firmId);
      if (!f) throw new Error("the firm is not onboarded");
      if (c.batch.phase === "reduce") {
        const n = await asOperator(() => writeReduceRows(ctx, c.run, c.batch, f.driveId));
        await ctx.runMutation(internal.runs.updateBatch, { batchId, patch: {}, event: { type: "rows", detail: `Report: ${n} checklist rows handed over` } });
      }
      const sid = await startSession(c.batch, c.run, f);
      const now = Date.now();
      const live = await ctx.runMutation(internal.runs.updateBatch, {
        batchId,
        patch: { status: "working", kortixSessionId: sid, startedAt: now, lastProgressAt: now, lastPromptAt: now },
        event: {
          type: "working",
          detail: c.batch.phase === "reduce"
            ? "Report: the agent is writing the report from the checklist"
            : c.run.kind === "draft"
              ? `The agent is drafting${c.batch.documentIds.length ? ` from ${c.batch.documentIds.length} source document${c.batch.documentIds.length === 1 ? "" : "s"}` : ""}`
              : `Batch ${c.batch.index + 1}: the agent is reading ${c.batch.documentIds.length} document${c.batch.documentIds.length === 1 ? "" : "s"}`,
        },
      });
      if (live) await ctx.scheduler.runAfter(pollDelay(now), internal.engine.poll, { batchId });
      else await stop(f, sid);
    } catch (err) {
      console.error(`[lumen] batch ${batchId}: launch: ${errorText(err)}`);
      await ctx.runMutation(internal.runs.settleBatch, { batchId, status: "failed", error: "The workspace could not start" });
    }
    return null;
  },
});

async function stop(f: FirmContext, sessionId: string) {
  const h = firmClient(f.secret).kortix.session(f.projectId, sessionId);
  await h.abort().catch(() => undefined);
  await h.stop().catch(() => undefined);
}

export const stopSessions = internalAction({
  args: { runId: v.id("runs"), sessions: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { runId, sessions }) => {
    const p = (await ctx.runQuery(internal.runs.forPrepare, { runId })) as Prep | null;
    const f = p && (await firmOf(ctx, p.run.firmId));
    if (!f) return null;
    for (const sid of sessions) await stop(f, sid);
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

/** What the batch still owes: the documents with no accepted row, or its one result file. */
function missing(c: { run: Doc<"runs">; batch: Doc<"runBatches"> }, accepted: Set<string>): string[] {
  const { file } = resultContract(c.run.kind, c.batch.phase);
  if (file) return accepted.has(file) ? [] : [file];
  return c.batch.documentIds.filter((id) => !accepted.has(`out/rows/${id}.json`)).map((id) => `out/rows/${id}.json`);
}

/** The files a result names (redline.docx, draft.docx), read from Drive into Lumen's storage. Null while one has not synced yet. */
async function storeFiles(ctx: ActionCtx, driveId: string, dir: string, names: string[]) {
  const out = [];
  for (const name of names.slice(0, 5)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) continue;
    let blob: Blob;
    try {
      blob = (await readDriveFile(driveId, `${dir}/out/${name}`)).blob;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
    const type = name.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : blob.type;
    const storageId = await ctx.storage.store(new Blob([await blob.arrayBuffer()], { type }));
    out.push({ name, storageId, bytes: blob.size });
  }
  return out;
}

/** A named file that has not reached Drive this long after its result is reported as missing. */
const FILE_SYNC_MS = 90_000;

/** A prompt to the batch's session, on the session's own agent (no per-prompt agent override). */
async function prompt(f: FirmContext, batch: Doc<"runBatches">, text: string) {
  await firmClient(f.secret).kortix.session(f.projectId, batch.kortixSessionId!).send(text);
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
    const { batch, run } = c as { batch: Doc<"runBatches">; run: Doc<"runs"> };
    const f = await firmOf(ctx, run.firmId);
    if (!f) return void (await ctx.runMutation(internal.runs.settleBatch, { batchId, status: "failed", error: "The firm workspace is not ready" }));
    const seen = new Map<string, { version: string; status: string }>(c.files.map((f: { path: string; version: string; status: string }) => [f.path, f]));
    const dir = batchDir(run.firmId, run._id, batchId);
    const driveId = f.driveId;
    const settle = async (status: "succeeded" | "failed", error?: string) => {
      await ctx.runMutation(internal.runs.settleBatch, { batchId, status, error });
      // The work is in Drive and Convex: free the sandbox. Its transcript stays readable.
      await stop(f, batch.kortixSessionId!).catch(() => undefined);
    };
    const fail = (error: string) => settle("failed", error);
    const again = () => ctx.scheduler.runAfter(pollDelay(batch.startedAt), internal.engine.poll, { batchId });
    try {
      const listed = await asOperator(() => listOutputs(driveId, dir));
      // Only the files the contract names are results: a scratch JSON the agent leaves in out/ is not one.
      const { file: resultFile } = resultContract(run.kind, batch.phase);
      const files = listed.files.filter((f) => (resultFile ? f.path === resultFile : /^out\/rows\/[^/]+\.json$/.test(f.path)));
      const done = listed.done;
      const rejected: string[] = [];
      let waiting = false;
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
        const errors = schemaErrors(resultContract(run.kind, batch.phase).schema, value);
        if (errors.length) {
          await ctx.runMutation(internal.runs.recordFile, { batchId, path: f.path, version: f.version, status: "rejected", errors });
          rejected.push(...errors.map((e) => `${f.path}: ${e}`));
          continue;
        }
        const named = Array.isArray((value as { files?: unknown }).files) ? ((value as { files: string[] }).files) : [];
        const stored = named.length ? await asOperator(() => storeFiles(ctx, driveId, dir, named)) : [];
        if (!stored) {
          // The result names a file Drive does not have yet: read the result again next poll.
          const since = await ctx.runMutation(internal.runs.markWaiting, { batchId });
          if (Date.now() - since > FILE_SYNC_MS) {
            // Report it once, then give the repaired write a fresh window.
            await ctx.runMutation(internal.runs.markWaiting, { batchId, reset: true });
            rejected.push(`${f.path}: it lists ${named.join(", ")}, but ${named.length === 1 ? "that file is" : "those files are"} not in out/. Write ${named.length === 1 ? "it" : "them"} to ${sandboxPath(dir)}/out/.`);
          }
          waiting = true;
          continue;
        }
        const problems = await ctx.runMutation(internal.runs.ingestResult, { batchId, path: f.path, version: f.version, value, files: stored });
        rejected.push(...problems);
        seen.set(f.path, { version: f.version, status: "accepted" });
      }
      const accepted = new Set([...seen].filter(([, s]) => s.status === "accepted").map(([p]) => p));
      const owed = missing({ run, batch }, accepted);
      const now = Date.now();

      if (now - (run.startedAt ?? now) > RUN_TIMEOUT_MS) return void (await fail("The run took longer than 60 minutes"));
      if (now - (batch.lastProgressAt ?? now) > NO_PROGRESS_MS) return void (await fail("No progress for 20 minutes"));

      if (waiting && rejected.length === 0) return void (await again());
      const doneIsNew = !!done && seen.get("done.json")?.version !== done.version;
      if (done && doneIsNew) {
        const d = (await asOperator(() => readJson(driveId, `${dir}/done.json`)).catch(() => null)) as { status?: string; error?: string } | null;
        await ctx.runMutation(internal.runs.recordFile, { batchId, path: "done.json", version: done.version, status: "accepted" });
        if (d?.status === "failed" && owed.length === 0) return void (await settle("succeeded"));
        if (d?.status === "failed") return void (await fail(`The agent stopped: ${String(d.error ?? "no reason given").slice(0, 300)}`));
      }
      if (done && owed.length === 0 && rejected.length === 0) {
        // done.json is in (now or before a repair) and every result is accepted.
        await ctx.runMutation(internal.runs.updateBatch, { batchId, patch: { status: "validating" }, event: { type: "validating", detail: `${batch.phase === "reduce" ? "Report" : `Batch ${batch.index + 1}`}: results checked` } });
        return void (await settle("succeeded"));
      }
      if (doneIsNew) rejected.push(...owed.map((p) => `${p} is missing`));
      else if (!done && owed.length === 0 && rejected.length === 0 && files.length > 0) {
        // Every result is in; done.json may still be on its way. Give it the grace period, then accept.
        if (now - (batch.lastProgressAt ?? now) > PROMPT_GRACE_MS) return void (await settle("succeeded"));
      }

      if (rejected.length) {
        if (batch.attempts.repair >= LIMITS.repair) return void (await fail(`Results stayed invalid after ${LIMITS.repair} repairs: ${rejected[0]}`));
        await prompt(f, batch, `Lumen rejected these results. Fix each one, write the files again with \`lumen result write\`, then run \`lumen result done\` again:\n- ${rejected.slice(0, 12).join("\n- ")}`);
        await ctx.runMutation(internal.runs.updateBatch, {
          batchId, patch: { attempts: { ...batch.attempts, repair: batch.attempts.repair + 1 }, lastPromptAt: now, lastProgressAt: now },
          event: { type: "repair", detail: `Batch ${batch.index + 1}: asked the agent to fix ${rejected.length} problem${rejected.length === 1 ? "" : "s"}` },
        });
        await again();
        return null;
      }

      if (now - (batch.lastPromptAt ?? 0) > PROMPT_GRACE_MS) {
        const turn = await asFirm(f.secret, () => getSessionTurn(f.projectId, batch.kortixSessionId!, { showErrors: false }));
        const ended = turn.last_ended?.ended_at ? Date.parse(turn.last_ended.ended_at) : 0;
        const idle = turn.turns.length === 0 && ended > (batch.lastPromptAt ?? 0);
        if (idle) {
          const failed = turn.last_ended?.error || turn.last_ended?.end_reason === "error";
          if (failed) {
            if (batch.attempts.relaunch >= LIMITS.relaunch) return void (await fail("The workspace failed twice"));
            const old = batch.kortixSessionId!;
            const sid = await startSession(batch, run, f);
            await stop(f, old);
            await ctx.runMutation(internal.runs.updateBatch, {
              batchId,
              patch: { kortixSessionId: sid, attempts: { ...batch.attempts, relaunch: batch.attempts.relaunch + 1 }, lastPromptAt: now, lastProgressAt: now },
              event: { type: "relaunch", detail: `Batch ${batch.index + 1}: the workspace failed; started a new one` },
            });
          } else {
            if (batch.attempts.nudge >= LIMITS.nudge) return void (await fail(`The agent stopped before finishing: ${owed.length} result${owed.length === 1 ? "" : "s"} missing`));
            await prompt(f, batch, `You stopped before the batch was finished. Still missing: ${owed.join(", ") || "done.json"}. Continue from where you are: write the missing results with \`lumen result write\`, then run \`lumen result done\`. Do not ask questions.`);
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
