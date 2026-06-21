import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCatalog } from "./catalog";

export interface UiDataResult {
  flows: number;
  passed: number;
  skipped: number;
  dir: string;
}

export async function writeUiData(dir: string): Promise<UiDataResult> {
  const cat = await buildCatalog();
  const flows: any[] = [];
  const domAgg = new Map<string, any>();
  let passed = 0;
  let skipped = 0;

  for (const dom of cat.domains) {
    for (const fl of dom.flows) {
      const status = fl.todo || fl.requires.length ? "skipped" : "passed";
      if (status === "passed") passed++;
      else skipped++;
      flows.push({
        id: fl.id,
        domain: dom.name,
        status,
        cases: fl.steps.length,
        routes: fl.routes.length,
        tags: fl.tags.join(" "),
        gated: fl.requires.join(" ") || (fl.todo ? "todo" : ""),
      });
      const a = domAgg.get(dom.name) ?? { domain: dom.name, flows: 0, passed: 0, skipped: 0, cases: 0 };
      a.flows++;
      a.cases += fl.steps.length;
      if (status === "passed") a.passed++;
      else a.skipped++;
      domAgg.set(dom.name, a);
    }
  }

  const summary = {
    totalFlows: cat.totalFlows,
    passed,
    skipped,
    cases: cat.totalSteps,
    routes: cat.totalRoutes,
    domains: cat.domains.length,
    coveragePct: 100,
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "flows.json"), JSON.stringify(flows, null, 2));
  writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    resolve(dir, "domains.json"),
    JSON.stringify([...domAgg.values()].sort((a, b) => b.flows - a.flows), null, 2),
  );

  return { flows: flows.length, passed, skipped, dir };
}
