import { resolve } from "node:path";
import { allFlows } from "./flow";
import { discoverFlows } from "./runner";
import { log } from "./log";

interface RouteManifest {
  routes: Array<{ method: string; path: string }>;
}

const SPEC_PATH = resolve(import.meta.dir, "../../spec/end-to-end.md");
const ROUTES_PATH = resolve(import.meta.dir, "../../spec/routes.generated.json");

export async function runCoverage(): Promise<boolean> {
  await discoverFlows();

  const specIds = await readSpecIds();
  const manifestRoutes = await readManifestRoutes();
  const flows = allFlows();
  const errors: string[] = [];
  const coveredRoutes = new Set<string>();

  for (const flow of flows) {
    if (!specIds.has(flow.id)) {
      errors.push(`flow ${flow.id} is not listed in tests/spec/end-to-end.md`);
    }

    for (const route of flow.meta.routes ?? []) {
      const normalized = normalizeRoute(route);
      if (!manifestRoutes.has(normalized)) {
        errors.push(`flow ${flow.id} references unknown route ${route}`);
      } else {
        coveredRoutes.add(normalized);
      }
    }
  }

  const uncovered = [...manifestRoutes].filter((route) => !coveredRoutes.has(route));
  log.info(`ke2e coverage: ${flows.length} flows, ${coveredRoutes.size}/${manifestRoutes.size} routes referenced`);
  if (uncovered.length) {
    log.info(log.dim(`WIP: ${uncovered.length} manifest routes do not have static flow coverage yet`));
  }

  if (errors.length) {
    for (const error of errors) log.error(error);
    return false;
  }

  log.pass("coverage structure is valid");
  return true;
}

async function readSpecIds(): Promise<Set<string>> {
  const markdown = await Bun.file(SPEC_PATH).text();
  const ids = new Set<string>();
  const idPattern = /`([A-Z][A-Z0-9]*-\d+[a-z]?)`/g;
  const rangePattern = /`([A-Z][A-Z0-9]*-)(\d+)\.\.(\d+)`/g;

  for (const match of markdown.matchAll(idPattern)) ids.add(match[1]);
  for (const match of markdown.matchAll(rangePattern)) {
    const [, prefix, start, end] = match;
    for (let n = Number(start); n <= Number(end); n++) ids.add(`${prefix}${n}`);
  }

  return ids;
}

async function readManifestRoutes(): Promise<Set<string>> {
  const manifest = (await Bun.file(ROUTES_PATH).json()) as RouteManifest;
  return new Set(manifest.routes.map((route) => normalizeRoute(`${route.method} ${route.path}`)));
}

function normalizeRoute(route: string): string {
  const [method, rawPath] = route.trim().split(/\s+/, 2);
  if (!method || !rawPath) throw new Error(`Invalid route template "${route}"`);
  return `${method.toUpperCase()} ${rawPath.replace(/\/+$/, "") || "/"}`;
}
