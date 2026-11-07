import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';
import * as rootModule from './index';
import * as reactModule from './react/index';

/**
 * Workspace names (Marko, 2026-11-06: "it's all workspaces; projects and
 * accounts are aliases"). Every public export whose name says Project has a
 * workspace-named twin: the SAME function, class, value or type under the
 * workspace name. The project name stays exported forever and carries
 * `@deprecated Use `<twin>`. Kept permanently.`
 *
 * A function or class is declared under the workspace name and the project
 * name is a `const` alias of it. The other way round, the workspace name
 * would inherit the deprecated signature and an editor would strike it
 * through. A type or a non-callable value is the reverse: the twin is
 * `type Workspace… = Project…` (`const` for a value).
 *
 * A project-named export without a twin is on one of three lists below, each
 * row with its reason. A new project-named export fails this file until it
 * gets a twin (see `listWorkspaceTriggers` / `listProjectTriggers` in
 * `core/rest/projects-client/triggers.ts` for the pattern) or a row.
 */

/** Not the platform workspace, so no twin. name → reason. */
const NOT_THE_WORKSPACE: Record<string, string> = {};
const DAEMON = 'the sandbox daemon board project (kortix-master), not the platform workspace';
for (const name of [
  'CreateProjectAgentInput', 'KortixMasterProject', 'PatchKortixMasterProjectInput', 'PatchKortixProjectInput', 'ProjectAgent',
  'ProjectField', 'UpdateProjectAgentInput', 'createProjectAgent', 'deleteKortixProject', 'deleteProjectAgent', 'getKortixProject',
  'getKortixProjectBySession', 'getProjectActivity', 'listKortixProjectSessions', 'listKortixProjects', 'listProjectAgents',
  'patchKortixProject', 'updateProjectAgent', 'KortixProjectQueryOptions', 'ProjectNotification', 'useCreateProjectAgent',
  'useDeleteProject', 'useDeleteProjectAgent', 'useKortixProject', 'useKortixProjectForSession', 'useKortixProjectSessions',
  'useKortixProjects', 'usePatchProject', 'useProjectActivity', 'useProjectAgents', 'useUpdateProjectAgent',
]) NOT_THE_WORKSPACE[name] = DAEMON;
for (const name of ['Project', 'EventProjectUpdated', 'ProjectCommands', 'ProjectIcon', 'ProjectTime', 'ProjectVcs', 'RuntimeProjectInfo']) {
  NOT_THE_WORKSPACE[name] = "the session runtime's (OpenCode-compatible) project record, not the platform workspace";
}
for (const name of [
  'projectCompacting', 'projectWorking', 'WorkingProjection', 'projectConfigAgentsToRuntimeAgents', 'projectLlmCatalogToProviderList',
  'projectSessionConnection', 'projectSessionStartSeed',
]) NOT_THE_WORKSPACE[name] = '"project" is the verb (computes a projection), not the entity';
NOT_THE_WORKSPACE.workspaceFromProject = 'converts a project record into a Workspace: it names both';
NOT_THE_WORKSPACE.WORKSPACE_HAS_PROJECT_CODE = 'the wire error code `workspace_has_project`';
NOT_THE_WORKSPACE.isWorkspaceHasProjectError = 'tests for the wire error code `workspace_has_project`';
for (const name of [
  'ensureWarmProjectSession', 'claimWarmProjectSession', 'WarmProjectSessionWorkspaceRefresh', 'WarmProjectSessionResult',
  'ClaimWarmProjectSessionInput', 'EnsureWarmProjectSessionOptions',
]) NOT_THE_WORKSPACE[name] = 'warm sessions were removed (2026-11-03): @deprecated, removed in the next major';
NOT_THE_WORKSPACE.ProjectMonitorMode = 'the monitor box was removed: @deprecated, the API sends null';
NOT_THE_WORKSPACE.listProjectMounts = 'always empty since 2026-11-03: @deprecated';
NOT_THE_WORKSPACE.projectMountsQueryOptions = 'the query of listProjectMounts, always empty since 2026-11-03';

/** `@kortix/sdk/react` only: `KortixProject` there is the daemon's (the root's is the platform workspace). */
const NOT_THE_WORKSPACE_IN_REACT: Record<string, string> = { KortixProject: DAEMON };

/**
 * Deprecated for a workspace name that is NOT the same function or type: the
 * workspace call answers more (or the canonical route), so the deprecation
 * names it, and no identical twin exists. name → replacement.
 */
const WORKSPACE_REPLACEMENTS: Record<string, string> = {
  updateProject: 'updateWorkspace',
  getProject: 'getWorkspace',
  listProjects: 'listWorkspaces',
  createProject: 'linkRepository',
  inviteProjectMember: 'inviteWorkspaceMember',
  useProjects: 'useWorkspaces',
  UseProjectsOptions: 'UseWorkspacesOptions',
  projectsQueryOptions: 'useWorkspaces',
  ProjectsKey: 'useWorkspaces',
  ProjectsListKey: 'useWorkspaces',
  ProjectHandle: 'WorkspaceHandle',
  ProjectRole: 'WorkspaceRole',
};

/** Project-named and current: no workspace name exists. name → reason. */
const NO_WORKSPACE_NAME: Record<string, string> = {
  PROJECT_ACTIONS: 'the values are the IAM action ids (`project.*`); their workspace names are `WorkspaceAction` / `toWorkspaceAction`',
  ProjectAction: 'a union of the IAM action ids (`project.*`); the workspace names are `WorkspaceAction`',
};

/** The workspace twin of a project name: every Project/project/PROJECT becomes Workspace/workspace/WORKSPACE. */
function workspaceTwinName(name: string): string {
  return name
    .replace(/PROJECTS/g, 'WORKSPACES')
    .replace(/PROJECT/g, 'WORKSPACE')
    .replace(/Projects/g, 'Workspaces')
    .replace(/Project/g, 'Workspace')
    .replace(/projects/g, 'workspaces')
    .replace(/project/g, 'workspace');
}

const program = ts.createProgram([join(import.meta.dir, 'index.ts'), join(import.meta.dir, 'react/index.ts')], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  skipLibCheck: true,
  noEmit: true,
});
const checker = program.getTypeChecker();

function exportsOf(entry: string): Map<string, ts.Symbol> {
  const file = program.getSourceFile(join(import.meta.dir, entry));
  if (!file) throw new Error(`${entry} is not in the program`);
  const moduleSymbol = checker.getSymbolAtLocation(file)!;
  return new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol]));
}

const resolve = (symbol: ts.Symbol) => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);

function deprecation(symbol: ts.Symbol): string | null {
  const tag = resolve(symbol).getJsDocTags(checker).find((t) => t.name === 'deprecated');
  return tag ? ts.displayPartsToString(tag.text ?? []) : null;
}

/** A call or construct signature of the symbol's value that carries `@deprecated` (an editor strikes the call through). */
function deprecatedSignature(symbol: ts.Symbol): boolean {
  const target = resolve(symbol);
  if (!(target.flags & ts.SymbolFlags.Value) || !target.valueDeclaration) return false;
  const type = checker.getTypeOfSymbolAtLocation(target, target.valueDeclaration);
  return [...type.getCallSignatures(), ...type.getConstructSignatures()].some((signature) =>
    signature.getJsDocTags().some((t) => t.name === 'deprecated'),
  );
}

const ENTRIES = [
  { entry: 'index.ts', label: '@kortix/sdk', runtime: rootModule as Record<string, unknown> },
  { entry: 'react/index.ts', label: '@kortix/sdk/react', runtime: reactModule as Record<string, unknown> },
];

type Row = { label: string; name: string; twin: string; symbol: ts.Symbol; twinSymbol?: ts.Symbol; runtime: Record<string, unknown> };
const twins: Row[] = [];
const replaced: Array<{ label: string; name: string; replacement: string; symbol: ts.Symbol; replacementSymbol?: ts.Symbol }> = [];
const unexplained: string[] = [];
for (const { entry, label, runtime } of ENTRIES) {
  const surface = exportsOf(entry);
  for (const [name, symbol] of surface) {
    if (!/project/i.test(name)) continue;
    if (name in NOT_THE_WORKSPACE || name in NO_WORKSPACE_NAME) continue;
    if (label === '@kortix/sdk/react' && name in NOT_THE_WORKSPACE_IN_REACT) continue;
    if (name in WORKSPACE_REPLACEMENTS) {
      const replacement = WORKSPACE_REPLACEMENTS[name]!;
      replaced.push({ label, name, replacement, symbol, replacementSymbol: surface.get(replacement) });
      continue;
    }
    const twin = workspaceTwinName(name);
    const twinSymbol = surface.get(twin);
    if (!twinSymbol) unexplained.push(`${label}: ${name} has no ${twin}`);
    twins.push({ label, name, twin, symbol, twinSymbol, runtime });
  }
}

describe('workspace names', () => {
  test('every project-named export has a workspace twin, a named replacement, or a written reason', () => {
    expect(twins.length).toBeGreaterThan(400);
    expect(unexplained).toEqual([]);
  });

  test('each twin is the same function, class or value at runtime', () => {
    const different = twins
      .filter((row) => row.name in row.runtime)
      .filter((row) => row.runtime[row.twin] !== row.runtime[row.name])
      .map((row) => `${row.label}: ${row.twin} is not ${row.name}`);
    expect(different).toEqual([]);
  });

  test('each twin is the same type', () => {
    const different = twins
      .filter((row) => row.twinSymbol && resolve(row.symbol).flags & ts.SymbolFlags.Type)
      .filter((row) => {
        const a = checker.getDeclaredTypeOfSymbol(resolve(row.symbol));
        const b = checker.getDeclaredTypeOfSymbol(resolve(row.twinSymbol!));
        return !(checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a));
      })
      .map((row) => `${row.label}: type ${row.twin} is not ${row.name}`);
    expect(different).toEqual([]);
  });

  test('each project name is @deprecated for its twin and kept permanently', () => {
    const wrong = twins
      .filter((row) => {
        const text = deprecation(row.symbol) ?? '';
        return !text.includes(`Use \`${row.twin}\``) || !/Kept permanently\./.test(text) || /Removed in the next major/.test(text);
      })
      .map((row) => `${row.label}: ${row.name} → ${JSON.stringify(deprecation(row.symbol))}`);
    expect(wrong).toEqual([]);
  });

  test('each twin is current: no @deprecated on the name or on its signature', () => {
    const wrong = twins
      .filter((row) => row.twinSymbol && (deprecation(row.twinSymbol) !== null || deprecatedSignature(row.twinSymbol)))
      .map((row) => `${row.label}: ${row.twin}`);
    expect(wrong).toEqual([]);
  });

  test('each replaced project name is @deprecated for its exported, current replacement', () => {
    expect(replaced.length).toBeGreaterThan(0);
    for (const row of replaced) {
      expect({ name: row.name, replacement: Boolean(row.replacementSymbol) }).toEqual({ name: row.name, replacement: true });
      expect({ name: row.name, deprecation: (deprecation(row.symbol) ?? '').includes(`\`${row.replacement}`) }).toEqual({
        name: row.name,
        deprecation: true,
      });
      expect({ replacement: row.replacement, current: deprecation(row.replacementSymbol!) === null }).toEqual({
        replacement: row.replacement,
        current: true,
      });
    }
  });

  test('every list row names an exported name', () => {
    const exported = new Set(ENTRIES.flatMap(({ entry }) => [...exportsOf(entry).keys()]));
    const stale = [...Object.keys(NOT_THE_WORKSPACE), ...Object.keys(NO_WORKSPACE_NAME), ...Object.keys(WORKSPACE_REPLACEMENTS)].filter(
      (name) => !exported.has(name),
    );
    expect(stale).toEqual([]);
  });

  test('a project name with no workspace name stays current', () => {
    for (const name of Object.keys(NO_WORKSPACE_NAME)) {
      const symbol = exportsOf('index.ts').get(name) ?? exportsOf('react/index.ts').get(name)!;
      expect({ name, deprecated: deprecation(symbol) !== null }).toEqual({ name, deprecated: false });
    }
  });
});
