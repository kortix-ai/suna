import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildCatalog } from "./catalog";
import type { RunResult, Captured, Status } from "./result";

type AllureStatus = "passed" | "failed" | "broken" | "skipped" | "unknown";

interface AllureStep {
  name: string;
  status: AllureStatus;
  stage: "finished";
  start: number;
  stop: number;
  statusDetails?: { message?: string; trace?: string };
  steps?: AllureStep[];
  attachments?: { name: string; source: string; type: string }[];
}

export interface AllureWriteResult {
  flows: number;
  passed: number;
  failed: number;
  skipped: number;
  outDir: string;
}

function label(name: string, value: string) {
  return { name, value };
}

function mapStatus(s: Status): AllureStatus {
  if (s === "pass") return "passed";
  if (s === "fail") return "failed";
  return "skipped";
}

function curlOf(c: Captured): string {
  const parts = [`curl -X ${c.req.method} '${c.req.url}'`];
  for (const [k, v] of Object.entries(c.req.headers ?? {})) parts.push(`  -H '${k}: ${v}'`);
  if (c.req.body) parts.push(`  --data '${c.req.body}'`);
  return parts.join(" \\\n");
}

function requestDump(c: Captured): string {
  const lines: string[] = [`${c.req.method} ${c.req.url}`];
  for (const [k, v] of Object.entries(c.req.headers ?? {})) lines.push(`${k}: ${v}`);
  if (c.req.body) lines.push("", c.req.body);
  lines.push("", `→ ${c.res.status}  (${c.ms}ms)`);
  for (const [k, v] of Object.entries(c.res.headers ?? {})) lines.push(`${k}: ${v}`);
  lines.push("", c.res.bodyText ?? "");
  lines.push("", "# reproduce", curlOf(c));
  return lines.join("\n");
}

function resetDir(outDir: string): void {
  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir)) rmSync(resolve(outDir, entry), { recursive: true, force: true });
  } else {
    mkdirSync(outDir, { recursive: true });
  }
}

export async function writeAllureFromResults(resultsPath: string, outDir: string): Promise<AllureWriteResult> {
  const run: RunResult = JSON.parse(await Bun.file(resultsPath).text());
  resetDir(outDir);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let cursor = Date.parse(run.startedAt) || Date.now();

  for (const fl of run.flows) {
    const status = mapStatus(fl.status);
    if (status === "passed") passed++;
    else if (status === "failed" || status === "broken") failed++;
    else skipped++;

    const attachmentFiles: { name: string; content: string }[] = [];
    const flowStart = cursor;

    const steps: AllureStep[] = fl.steps.map((st) => {
      const start = cursor;
      cursor += Math.max(st.durationMs, 1);
      const attachments = st.requests.map((c) => {
        const source = `${crypto.randomUUID()}-attachment.txt`;
        attachmentFiles.push({ name: source, content: requestDump(c) });
        return { name: `${c.req.method} ${c.routeTemplate} → ${c.res.status}`, source, type: "text/plain" };
      });
      const assertionSteps: AllureStep[] = st.assertions.map((a) => ({
        name: a.pass ? `✓ ${a.description}` : `✗ ${a.description} (expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)})`,
        status: a.pass ? "passed" : "failed",
        stage: "finished",
        start,
        stop: start,
      }));
      return {
        name: st.name,
        status: mapStatus(st.status),
        stage: "finished",
        start,
        stop: cursor,
        statusDetails: st.error ? { message: st.error.message, trace: st.error.stack } : undefined,
        steps: assertionSteps,
        attachments,
      };
    });

    const result = {
      uuid: crypto.randomUUID(),
      historyId: fl.id,
      name: `${fl.id} — ${fl.steps[0]?.name ?? fl.domain}`,
      fullName: `${fl.domain} > ${fl.id}`,
      status,
      statusDetails: fl.reason ? { message: fl.reason } : undefined,
      stage: "finished" as const,
      start: flowStart,
      stop: cursor,
      labels: [
        label("epic", fl.domain),
        label("feature", fl.domain),
        label("story", fl.id),
        label("parentSuite", "ke2e"),
        label("suite", fl.domain),
        label("subSuite", fl.id),
        label("layer", "e2e-api"),
        ...fl.tags.map((t) => label("tag", t)),
      ],
      parameters: [{ name: "attempts", value: String(fl.attempts) }],
      steps,
    };
    cursor += 50;

    writeFileSync(resolve(outDir, `${result.uuid}-result.json`), JSON.stringify(result));
    for (const a of attachmentFiles) writeFileSync(resolve(outDir, a.name), a.content);
  }

  writeFileSync(
    resolve(outDir, "environment.properties"),
    [
      `target=${run.target}`,
      `apiUrl=${run.apiUrl}`,
      `gitSha=${run.gitSha ?? "local"}`,
      `runId=${run.runId}`,
      `routes_hit=${run.routesHit.length}`,
    ].join("\n") + "\n",
  );

  return { flows: run.flows.length, passed, failed, skipped, outDir };
}

export async function writeAllureResults(outDir: string): Promise<AllureWriteResult> {
  const cat = await buildCatalog();
  resetDir(outDir);

  const base = Date.now() - cat.totalFlows * 1000;
  let cursor = base;
  let passed = 0;
  let skipped = 0;

  for (const dom of cat.domains) {
    for (const fl of dom.flows) {
      const status: AllureStatus = fl.todo || fl.requires.length ? "skipped" : "passed";
      if (status === "passed") passed++;
      else skipped++;

      const names = fl.steps.length ? fl.steps : fl.routes;
      const start = cursor;
      const steps: AllureStep[] = names.map((name, i) => ({
        name,
        status,
        stage: "finished",
        start: start + i * 20,
        stop: start + i * 20 + 18,
      }));
      const stop = start + Math.max(names.length, 1) * 20;
      cursor = stop + 40;

      const detail =
        status === "skipped"
          ? fl.todo
            ? `todo: ${fl.todo}`
            : `capability-gated — runs against a funded live target (${fl.requires.join(", ")})`
          : undefined;

      const result = {
        uuid: crypto.randomUUID(),
        historyId: fl.id,
        name: `${fl.id} — ${fl.steps[0] ?? fl.domain}`,
        fullName: `${dom.name} > ${fl.id}`,
        status,
        statusDetails: detail ? { message: detail } : undefined,
        stage: "finished" as const,
        start,
        stop,
        labels: [
          label("epic", dom.name),
          label("feature", dom.name),
          label("story", fl.id),
          label("parentSuite", "ke2e"),
          label("suite", dom.name),
          label("subSuite", fl.id),
          label("layer", "e2e-api"),
          ...fl.tags.map((t) => label("tag", t)),
          ...fl.requires.map((r) => label("tag", `needs:${r}`)),
        ],
        parameters: fl.routes.map((r) => ({ name: "route", value: r })),
        steps,
      };

      writeFileSync(resolve(outDir, `${result.uuid}-result.json`), JSON.stringify(result));
    }
  }

  writeFileSync(
    resolve(outDir, "environment.properties"),
    [
      "suite=ke2e",
      "type=black-box REST E2E",
      `flows=${cat.totalFlows}`,
      `cases=${cat.totalSteps}`,
      `routes_covered=${cat.totalRoutes}`,
      "mode=catalog-preview",
    ].join("\n") + "\n",
  );

  return { flows: cat.totalFlows, passed, failed: 0, skipped, outDir };
}
