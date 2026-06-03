#!/usr/bin/env bun
/**
 * ke2e — Kortix end-to-end REST API test runner.
 *
 *   ke2e run [--domain d] [--id ID] [--tag t] [--grep s] [--workers N] [--smoke]
 *   ke2e list
 *   ke2e coverage
 *   ke2e gc [--older-than 2h] [--dry-run]
 *   ke2e report <results.json>
 */
import { resolve } from "node:path";
import { allFlows } from "../src/core/flow";
import { discoverFlows, runSuite } from "../src/core/runner";
import { renderStepSummary, writeResults } from "../src/core/report";
import { describeEnv, loadEnv } from "../src/core/env";
import { log } from "../src/core/log";
import { runCoverage } from "../src/coverage/check-coverage";
import { runGc } from "../src/fixtures/gc";

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

function list(v: string | boolean | undefined): string[] | undefined {
  if (typeof v !== "string") return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `${process.env.GITHUB_RUN_ID ?? ts}-${r}`;
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0] ?? "run";

  if (cmd === "list") {
    await discoverFlows();
    const flows = allFlows().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const f of flows) {
      const t = (f.meta.tags ?? []).join(",");
      console.log(`${f.id.padEnd(12)} ${f.meta.domain.padEnd(16)} ${t}`);
    }
    console.log(`\n${flows.length} flows`);
    return;
  }

  if (cmd === "coverage") {
    const ok = await runCoverage();
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "gc") {
    await runGc({ olderThan: (flags["older-than"] as string) ?? "2h", dryRun: !!flags["dry-run"] });
    return;
  }

  if (cmd === "report") {
    const file = _[1];
    if (!file) throw new Error("usage: ke2e report <results.json>");
    const jsonPath = resolve(file);
    const data = JSON.parse(await Bun.file(jsonPath).text());
    const out = jsonPath.replace(/\.json$/, ".html");
    writeResults(data, jsonPath, out);
    log.info(`report → ${out}`);
    return;
  }

  // run
  const env = loadEnv();
  const runId = newRunId();
  (globalThis as any).__KE2E_RUN_ID__ = runId;
  const outDir = (flags.out as string) ?? resolve(import.meta.dir, "../test-results", runId);
  const gitSha = process.env.GITHUB_SHA ?? (await gitShaLocal());

  log.info(log.bold(`ke2e run ${runId}`));
  log.info(log.dim(describeEnv(env)));

  const result = await runSuite({
    ids: list(flags.id),
    domains: list(flags.domain),
    tags: list(flags.tag),
    grep: typeof flags.grep === "string" ? flags.grep : undefined,
    workers: flags.workers ? Number(flags.workers) : undefined,
    smoke: !!flags.smoke,
    runId,
    gitSha,
  });

  const jsonPath = resolve(outDir, "results.json");
  const htmlPath = resolve(outDir, "report.html");
  writeResults(result, jsonPath, htmlPath);

  for (const f of result.flows) {
    if (f.status === "pass") log.pass(`${f.id} ${log.dim((f.durationMs / 1000).toFixed(2) + "s")}`);
    else if (f.status === "fail") log.fail(`${f.id} — ${f.reason}`);
    else if (f.status === "skip") log.skip(`${f.id} — ${f.reason}`);
    else log.skip(`${f.id} (todo) — ${f.reason}`);
  }
  const s = result.summary;
  log.info("");
  log.info(`${log.bold("results")}: ${s.passed}/${s.total} passed · ${s.failed} failed · ${s.skipped} skipped · ${s.todo} todo · ${(s.durationMs / 1000).toFixed(1)}s`);
  log.info(log.dim(`report → ${htmlPath}`));

  if (process.env.GITHUB_STEP_SUMMARY) {
    await Bun.write(process.env.GITHUB_STEP_SUMMARY, renderStepSummary(result));
  }

  process.exit(s.failed > 0 ? 1 : 0);
}

async function gitShaLocal(): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
    return (await new Response(p.stdout).text()).trim() || null;
  } catch {
    return null;
  }
}

main().catch((err) => {
  log.error(String(err?.stack ?? err));
  process.exit(2);
});
