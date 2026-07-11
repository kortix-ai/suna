import { resolve } from "node:path";
import { log } from "../core/log";
import { cliExempt, cliMapped } from "./cli-mapping";
import { computeCliParity, type CliParityResult, type Route } from "./cli-parity-core";

// CLI-parity gate: every API route in the manifest should be reachable from a
// `kortix` CLI command (cliMapped) or explicitly exempt (cliExempt). Because
// hundreds of routes predate any CLI, we freeze today's gap in a baseline and
// only fail on NEW routes — identical mechanism to the route-coverage gate
// (check-coverage.ts). Fully offline: reads the committed manifest + baseline,
// never boots a server. The pure diff logic lives in cli-parity-core.ts.

export interface CliParityOptions {
  updateBaseline?: boolean;
  json?: boolean;
}

const MANIFEST = resolve(import.meta.dir, "../../spec/routes.generated.json");
const BASELINE = resolve(import.meta.dir, "../../spec/cli-parity-baseline.json");

async function readRoutes(): Promise<Route[]> {
  const file = Bun.file(MANIFEST);
  if (!(await file.exists())) throw new Error(`route manifest missing: ${MANIFEST}`);
  const data = JSON.parse(await file.text());
  const routes = Array.isArray(data?.routes) ? data.routes : [];
  return routes.map((r: { method: unknown; path: unknown }) => ({
    method: String(r.method),
    path: String(r.path),
  }));
}

async function readBaseline(): Promise<string[]> {
  const file = Bun.file(BASELINE);
  if (!(await file.exists())) return [];
  const data = JSON.parse(await file.text());
  return Array.isArray(data?.unmapped) ? data.unmapped : [];
}

export async function runCliParity(opts: CliParityOptions = {}): Promise<boolean> {
  const routes = await readRoutes();
  const baselineUnmapped = await readBaseline();
  const result = computeCliParity({
    routes,
    mapped: cliMapped,
    exempt: cliExempt,
    baselineUnmapped,
    updateBaseline: opts.updateBaseline,
  });

  if (opts.updateBaseline) {
    await Bun.write(BASELINE, `${JSON.stringify({ unmapped: result.unmapped }, null, 2)}\n`);
    log.info(`cli-parity baseline written → ${BASELINE} (${result.unmapped.length} unmapped)`);
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else renderReport(result);

  return result.pass;
}

function renderReport(r: CliParityResult): void {
  log.info(log.bold("cli parity — every API route maps to a CLI command or an explicit exemption"));
  log.info(
    `${log.bold(`${r.mapped}`)} mapped · ${r.exempt} exempt · ${r.unmapped.length} unmapped (frozen baseline) · ${r.total} routes`,
  );

  if (r.resolvedSinceBaseline.length) {
    log.pass(`${r.resolvedSinceBaseline.length} route(s) newly mapped/exempted since baseline`);
    log.info(log.dim("  run `npm --prefix tests run cli-parity -- --update-baseline` to lock in the improvement"));
  }

  if (r.newUnmapped.length) {
    log.fail(`${r.newUnmapped.length} new API route(s) shipped without a CLI command or exemption:`);
    for (const k of r.newUnmapped) log.info(log.dim(`  ${k}`));
    log.info(
      log.dim("  wire it into the CLI + add a cliMapped entry, or add a cliExempt entry with a reason, in tests/src/coverage/cli-mapping.ts"),
    );
  }

  log.info("");
  if (r.pass) log.pass("cli parity gate passed");
  else log.fail("cli parity gate failed");
}
