// Diff-scoped `pnpm test`: run only what the PR's changes can affect, and
// reuse lane groups that already passed on the same diff.
//
// The scope is a pure function of the files the branch changed against its
// merge-base with origin/dev (working tree included) and the workspace graph:
// declared dependencies (`pnpm --filter "...{dir}"` = a package plus every
// package that depends on it), relative imports across packages, and package
// files that name a changed workflow or Terraform file. A path the rules below
// do not recognise runs the whole suite. `CI=1` always runs the whole suite and
// never reuses.
import { relative } from 'node:path';
import type { LocalTestLane, LocalTestPlan } from './local-runner';

/** Paths no package reads. Their change runs only the always-on lanes. */
const NO_PACKAGE_PREFIXES = ['.agents/', '.claude/', 'tests/unit/'];
/** Paths a package test may read by literal path (a workflow, a Terraform file, a browser spec). */
const MENTIONED_PREFIXES = ['.github/', '.githooks/', 'infra/', 'tests/e2e/'];
/** Paths only the REST/CLI flows and DB suites read. */
const FLOW_PREFIXES = ['tests/src/flows/', 'tests/spec/', 'tests/migration/'];
/** Workspace packages the local REST/CLI flows and DB suites start or exercise. */
const FLOW_PACKAGES = ['apps/api', 'apps/cli', 'apps/llm-gateway', 'packages/db'];
/** The Docker-backed lanes: they start local Supabase and the API. */
const FLOW_LANES = ['api-cli-flows', 'db-suites'];

export type TestScope =
  | { full: true; reason: string }
  | { full: false; packages: string[]; flows: boolean; sdk: boolean };

export interface WorkspaceGraph {
  /** Every workspace package directory, relative to the repo root. */
  packageDirs: string[];
  /** The dirs plus every package that declares a dependency on one of them. */
  dependentsOf(dirs: string[]): string[];
  /** Packages that import `dir` by relative path (`../../packages/x`), which pnpm cannot see. */
  importersOf(dir: string): string[];
  /** Packages with a file that names `path` literally. */
  mentionsOf(path: string): string[];
}

/** `files` = the changed paths, or null on dev or without a merge-base. */
export function scopeFor(files: string[] | null, graph: WorkspaceGraph): TestScope {
  if (files === null) return { full: true, reason: 'no PR diff (on dev or no merge-base)' };
  // The runner's own workspace (`tests`) and the root are not product packages.
  const dirs = graph.packageDirs.filter((dir) => dir !== '' && dir !== 'tests');
  const owners = new Set<string>();
  let flows = false;
  for (const file of files) {
    if (NO_PACKAGE_PREFIXES.some((p) => file.startsWith(p)) || /^[^/]+\.md$/.test(file)) continue;
    if (FLOW_PREFIXES.some((p) => file.startsWith(p))) {
      flows = true;
      continue;
    }
    if (MENTIONED_PREFIXES.some((p) => file.startsWith(p))) {
      for (const dir of graph.mentionsOf(file)) owners.add(dir);
      continue;
    }
    const owner = dirs.find((dir) => file.startsWith(`${dir}/`));
    if (!owner) return { full: true, reason: `${file} is outside every scoped path` };
    owners.add(owner);
  }
  // Close over both edge kinds: declared dependencies and relative imports.
  const affected = new Set<string>();
  let next = [...owners];
  while (next.length > 0) {
    for (const dir of graph.dependentsOf(next)) affected.add(dir);
    next = [...affected]
      .flatMap((dir) => graph.importersOf(dir))
      .filter((dir) => !affected.has(dir));
  }
  const packages = [...affected].filter((dir) => dirs.includes(dir)).sort();
  return {
    full: false,
    packages,
    flows: flows || packages.some((dir) => FLOW_PACKAGES.includes(dir)),
    sdk: packages.includes('packages/sdk'),
  };
}

/** Attestation group -> the runner lanes it covers. A group is reused only as a whole. */
export const LANE_GROUPS: Record<string, string[]> = {
  core: ['sdk', 'flow-runner-unit', 'route-coverage', 'worktree-unit'],
  packages: ['package-quality'],
  'db-suites': ['api-cli-flows', 'db-suites'],
  browser: ['browser'],
};

/**
 * Narrow a core plan to `scope`, and drop the lane groups `freshLanes` (the
 * branch's attestation, still fresh for this diff) already records as `pass`.
 * Returns the plan, the lanes it dropped as unaffected, and the reused groups.
 */
export function scopePlan(
  plan: LocalTestPlan,
  scope: TestScope,
  freshLanes: Record<string, string>,
): { plan: LocalTestPlan; unaffected: string[]; reused: string[] } {
  const reused = Object.keys(LANE_GROUPS).filter((group) => freshLanes[group] === 'pass');
  const drop = new Set(reused.flatMap((group) => LANE_GROUPS[group] ?? []));
  const unaffected: string[] = [];
  if (!scope.full) {
    if (!scope.flows) unaffected.push(...FLOW_LANES);
    if (!scope.sdk) unaffected.push('sdk');
  }
  for (const name of unaffected) drop.add(name);
  const scoped = (lane: LocalTestLane): LocalTestLane =>
    lane.name === 'package-quality' && !scope.full
      ? { ...lane, env: { ...lane.env, KORTIX_TEST_SCOPE: JSON.stringify(scope.packages) } }
      : lane;
  const keep = (lanes: LocalTestLane[]) => lanes.filter((lane) => !drop.has(lane.name)).map(scoped);
  let stages = plan.stages.map(keep).filter((stage) => stage.length > 0);
  // Without the flows, the first stage is only the cheap lanes: run them beside
  // package quality instead of before it. The SDK keeps its own stage (its
  // wall-clock assertions).
  if (!stages.flat().some((lane) => FLOW_LANES.includes(lane.name))) {
    const sdk = stages.flat().filter((lane) => lane.name === 'sdk');
    const rest = stages.flat().filter((lane) => lane.name !== 'sdk');
    stages = [sdk, rest].filter((stage) => stage.length > 0);
  }
  return {
    plan: { ...plan, lanes: keep(plan.lanes), stages },
    unaffected: unaffected.filter((name) => !reused.some((g) => LANE_GROUPS[g]?.includes(name))),
    reused,
  };
}

function spawnText(command: string[], root: string, okCodes = [0]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'pipe', stderr: 'inherit' });
  if (!okCodes.includes(result.exitCode))
    throw new Error(`${command.join(' ')} exited with ${result.exitCode}`);
  return result.stdout.toString();
}

/** The workspace graph of the checkout at `root`, from pnpm and git grep. */
function workspaceGraph(root: string): WorkspaceGraph {
  const ls = (filters: string[]) =>
    (
      JSON.parse(spawnText(['pnpm', 'ls', '-r', '--depth', '-1', '--json', ...filters], root)) as {
        path: string;
      }[]
    ).map((pkg) => relative(root, pkg.path));
  const packageDirs = ls([]);
  const ownerOf = (file: string) =>
    packageDirs
      .filter((dir) => dir !== '' && file.startsWith(`${dir}/`))
      .sort((a, b) => b.length - a.length)[0];
  // `git grep` exits 1 on no match. Markdown never builds or tests anything.
  const grep = (args: string[]) =>
    spawnText(['git', 'grep', ...args, '--', 'apps', 'packages', ':!*.md'], root, [0, 1])
      .split('\n')
      .filter(Boolean);
  const importers = new Map<string, Set<string>>();
  for (const line of grep(['-oE', String.raw`(\.\./)+(apps|packages)/[A-Za-z0-9_-]+`])) {
    const [file = '', ref = ''] = line.split(':');
    const source = ownerOf(file);
    const target = ref.replace(/^(\.\.\/)+/, '');
    if (!source || source === target) continue;
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target)?.add(source);
  }
  return {
    packageDirs,
    dependentsOf: (dirs) => ls(dirs.flatMap((dir) => ['--filter', `...{./${dir}}`])),
    importersOf: (dir) => [...(importers.get(dir) ?? [])],
    mentionsOf: (path) =>
      [...new Set(grep(['-lF', '-e', path]).map(ownerOf))].filter((dir): dir is string =>
        Boolean(dir),
      ),
  };
}

/** The changed files, the still-fresh attestation lanes, and the scope for this checkout. */
export function resolveScope(root: string): {
  scope: TestScope;
  freshLanes: Record<string, string>;
  files: string[] | null;
} {
  if (process.env.CI) return { scope: { full: true, reason: 'CI' }, freshLanes: {}, files: null };
  const status = JSON.parse(
    spawnText(['node', 'tests/verify-attestation.mjs', 'status'], root),
  ) as {
    files: string[] | null;
    lanes: Record<string, string>;
  };
  return {
    scope: scopeFor(status.files, workspaceGraph(root)),
    freshLanes: status.lanes,
    files: status.files,
  };
}
