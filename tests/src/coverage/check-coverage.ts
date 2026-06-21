import { resolve } from "node:path";
import { discoverFlows } from "../core/runner";
import { allFlows } from "../core/flow";
import { log } from "../core/log";
import { externalRoutes, uncoveredAllow, type AllowEntry } from "./allowlist";

export interface CoverageOptions {
  updateBaseline?: boolean;
  json?: boolean;
}

export interface CoverageSummary {
  total: number;
  covered: number;
  allowlisted: number;
  uncovered: number;
  coveragePct: number;
  newUncovered: string[];
  newExternal: string[];
  malformed: string[];
  resolvedSinceBaseline: string[];
  orphanFlows: string[];
}

interface Route {
  method: string;
  path: string;
}

interface Baseline {
  uncovered: string[];
  external: string[];
}

const MANIFEST = resolve(import.meta.dir, "../../spec/routes.generated.json");
const BASELINE = resolve(import.meta.dir, "../../spec/coverage-baseline.json");

function normalize(method: string, path: string): string {
  const segs = path.split("/").map((s) => (s.startsWith(":") ? ":*" : s));
  return `${method.toUpperCase()} ${segs.join("/")}`;
}

function parseRouteString(raw: string): Route | null {
  const m = raw.trim().match(/^([A-Za-z]+)\s+(\/\S*)$/);
  if (!m) return null;
  return { method: m[1], path: m[2] };
}

async function readManifest(): Promise<Route[]> {
  const file = Bun.file(MANIFEST);
  if (!(await file.exists())) throw new Error(`route manifest missing: ${MANIFEST}`);
  const data = JSON.parse(await file.text());
  const routes = Array.isArray(data?.routes) ? data.routes : [];
  return routes.map((r: any) => ({ method: String(r.method), path: String(r.path) }));
}

async function readBaseline(): Promise<Baseline> {
  const file = Bun.file(BASELINE);
  if (!(await file.exists())) return { uncovered: [], external: [] };
  const data = JSON.parse(await file.text());
  return {
    uncovered: Array.isArray(data?.uncovered) ? data.uncovered : [],
    external: Array.isArray(data?.external) ? data.external : [],
  };
}

function allowSet(entries: AllowEntry[]): Set<string> {
  return new Set(entries.map((e) => normalize(e.method, e.path)));
}

export async function runCoverage(opts: CoverageOptions = {}): Promise<boolean> {
  await discoverFlows();
  const flows = allFlows();

  const manifest = await readManifest();
  const manifestSet = new Map<string, Route>();
  for (const r of manifest) manifestSet.set(normalize(r.method, r.path), r);

  const allowUncovered = allowSet(uncoveredAllow);
  const allowExternal = allowSet(externalRoutes);

  const declared = new Map<string, string[]>();
  const malformed: string[] = [];
  const orphanFlows: string[] = [];

  for (const f of flows) {
    const routes = f.meta.routes ?? [];
    if (routes.length === 0 && !f.meta.todo) orphanFlows.push(f.id);
    for (const raw of routes) {
      const parsed = parseRouteString(raw);
      if (!parsed) {
        malformed.push(`${f.id}: ${raw}`);
        continue;
      }
      const key = normalize(parsed.method, parsed.path);
      declared.set(key, [...(declared.get(key) ?? []), f.id]);
    }
  }

  const manifestKeys = [...manifestSet.keys()];
  const covered = manifestKeys.filter((k) => declared.has(k));
  const allowlisted = manifestKeys.filter((k) => !declared.has(k) && allowUncovered.has(k));
  const uncovered = manifestKeys
    .filter((k) => !declared.has(k) && !allowUncovered.has(k))
    .sort();
  const external = [...declared.keys()]
    .filter((k) => !manifestSet.has(k) && !allowExternal.has(k))
    .sort();

  if (opts.updateBaseline) {
    const next: Baseline = { uncovered, external };
    await Bun.write(BASELINE, JSON.stringify(next, null, 2) + "\n");
    log.info(`baseline written → ${BASELINE} (${uncovered.length} uncovered, ${external.length} external)`);
  }

  const baseline = await readBaseline();
  const baseUncovered = new Set(baseline.uncovered);
  const baseExternal = new Set(baseline.external);
  const newUncovered = uncovered.filter((r) => !baseUncovered.has(r));
  const newExternal = external.filter((r) => !baseExternal.has(r));
  const resolvedSinceBaseline = [...baseUncovered]
    .filter((r) => !uncovered.includes(r))
    .sort();

  const total = manifestSet.size;
  const coveragePct = total === 0 ? 100 : Math.round((covered.length / total) * 1000) / 10;

  const summary: CoverageSummary = {
    total,
    covered: covered.length,
    allowlisted: allowlisted.length,
    uncovered: uncovered.length,
    coveragePct,
    newUncovered,
    newExternal,
    malformed,
    resolvedSinceBaseline,
    orphanFlows,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  }

  const pass =
    malformed.length === 0 &&
    (opts.updateBaseline || (newUncovered.length === 0 && newExternal.length === 0));

  if (!opts.json) renderReport(summary, declared, opts);

  return pass;
}

function renderReport(
  s: CoverageSummary,
  declared: Map<string, string[]>,
  opts: CoverageOptions,
): void {
  log.info(log.bold("ke2e coverage — spec ↔ flow ↔ route parity"));
  log.info(
    `${log.bold(`${s.coveragePct}%`)} covered · ${s.covered}/${s.total} routes · ` +
      `${s.allowlisted} allowlisted · ${s.uncovered} uncovered`,
  );

  if (s.resolvedSinceBaseline.length) {
    log.pass(`${s.resolvedSinceBaseline.length} route(s) newly covered since baseline`);
    log.info(log.dim("  run `ke2e coverage --update-baseline` to lock in the improvement"));
  }

  if (s.malformed.length) {
    log.fail(`${s.malformed.length} malformed route string(s) in flow meta:`);
    for (const m of s.malformed) log.info(log.dim(`  ${m}`));
  }

  if (s.newExternal.length) {
    log.fail(`${s.newExternal.length} flow route(s) not in the API manifest (drift or typo):`);
    for (const r of s.newExternal) {
      log.info(log.dim(`  ${r}  ← ${(declared.get(r) ?? []).join(", ")}`));
    }
    log.info(
      log.dim("  regenerate the manifest (apps/api/scripts/dump-routes.ts), fix the route, or add to externalRoutes in allowlist.ts"),
    );
  }

  if (s.newUncovered.length) {
    log.fail(`${s.newUncovered.length} new uncovered API route(s) — add a flow or allowlist with a reason:`);
    for (const r of s.newUncovered) log.info(log.dim(`  ${r}`));
  }

  if (s.orphanFlows.length) {
    log.skip(`${s.orphanFlows.length} flow(s) declare no routes: ${s.orphanFlows.join(", ")}`);
  }

  const pass =
    s.malformed.length === 0 &&
    (opts.updateBaseline || (s.newUncovered.length === 0 && s.newExternal.length === 0));
  log.info("");
  if (pass) log.pass("coverage gate passed");
  else log.fail("coverage gate failed");
}
