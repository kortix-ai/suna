import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * The session runtime is OpenCode or pi, so a public name says "runtime", not
 * "opencode". Every name below is a pre-W4 name kept until the next major: it
 * is `@deprecated`, and its neutral replacement is public and NOT deprecated.
 * `null` = deprecated with no neutral replacement: it wraps an OpenCode-only
 * route, or no first-party host calls it, so the old name and the neutral name
 * are both removed in the next major (`CHANGELOG.md`, "Removed in the next
 * major").
 *
 * A NEW public name containing "opencode" fails the first test. Name it
 * neutrally instead ("runtime"); the harness is a server-side concern.
 */
const PRE_W4_NAMES: Record<string, string | null> = {
  CanonicalOpenCodeSession: 'CanonicalRuntimeSession',
  ExecuteOpenCodeCommandInput: 'ExecuteRuntimeCommandInput',
  OpenCodeConfigInvalidError: 'RuntimeConfigInvalidError',
  OpenCodeConfigIssue: 'RuntimeConfigIssue',
  OpenCodeEvent: 'RuntimeEvent',
  OpenCodeEventStreamProvider: 'RuntimeEventStreamProvider',
  OpenCodeLocal: 'RuntimeLocal',
  OpenCodeLocalAgent: 'RuntimeLocalAgent',
  OpenCodeLocalModel: 'RuntimeLocalModel',
  OpenCodeMessagesClient: 'RuntimeMessagesClient',
  OpenCodeProjectInfo: 'RuntimeProjectInfo',
  OpencodeAgentConfig: 'RuntimeAgentConfig',
  OpencodeClient: 'RuntimeClient',
  OpencodeClientConfig: 'RuntimeClientConfig',
  ProjectOpenCodeSession: 'ProjectRuntimeSession',
  SendOpenCodeMessageArgs: 'SendRuntimeMessageArgs',
  SendOpenCodeMessageError: 'SendRuntimeMessageError',
  UseOpenCodeLocalOptions: 'UseRuntimeLocalOptions',
  abortOpenCodeSession: 'abortRuntimeSession',
  canQueryOpenCodeSession: 'canQueryRuntimeSession',
  clearOpencodeEnsureGuard: 'clearRuntimeEnsureGuard',
  createOpencodeClient: 'createRuntimeClient',
  executeOpenCodeCommand: 'executeRuntimeCommand',
  findOpenCodeFiles: 'findRuntimeFiles',
  formatOpenCodeRuntimeError: 'formatRuntimeError',
  getActiveOpenCodeUrl: 'getActiveRuntimeUrl',
  getOpenCodeConfigInvalidError: 'getRuntimeConfigInvalidError',
  isOpenCodeConfigInvalidError: 'isRuntimeConfigInvalidError',
  isOpenCodeNotReadyError: 'isRuntimeNotReadyError',
  opencodeKeys: 'runtimeKeys',
  parseOpenCodeErrorPayload: 'parseRuntimeErrorPayload',
  projectConfigAgentsToOpenCodeAgents: 'projectConfigAgentsToRuntimeAgents',
  promptOpenCodeMessage: 'promptRuntimeMessage',
  setOpenCodeHealth: 'setRuntimeHealth',
  useAbortOpenCodeSession: 'useAbortRuntimeSession',
  useCanonicalOpenCodeSession: 'useCanonicalRuntimeSession',
  useCreateOpenCodeSession: 'useCreateRuntimeSession',
  useDeleteOpenCodeSession: null,
  useExecuteOpenCodeCommand: 'useExecuteRuntimeCommand',
  useOpenCodeAgent: null,
  useOpenCodeAgents: 'useRuntimeAgents',
  useOpenCodeCommands: 'useRuntimeCommands',
  useOpenCodeConfig: 'useRuntimeConfig',
  useOpenCodeCurrentProject: 'useRuntimeCurrentProject',
  useOpenCodeEventStream: 'useRuntimeEventStream',
  useOpenCodeLocal: 'useRuntimeLocal',
  useOpenCodeMcpStatus: null,
  useOpenCodeMessages: 'useRuntimeMessages',
  useOpenCodePathInfo: 'useRuntimePathInfo',
  useOpenCodePendingStore: 'useRuntimePendingStore',
  useOpenCodeProjects: null,
  useOpenCodeProviders: 'useRuntimeProviders',
  useOpenCodePtyList: 'useRuntimePtyList',
  useOpenCodeRuntimeReady: 'useRuntimeReady',
  useOpenCodeSession: 'useRuntimeSession',
  useOpenCodeSessionDiff: null,
  useOpenCodeSessionTodo: 'useRuntimeSessionTodo',
  useOpenCodeSessions: 'useRuntimeSessions',
  useOpenCodeSkills: null,
  useOpenCodeToolIds: null,
  useOpenCodeTools: null,
  useOpenCodeVcsDiff: 'useRuntimeVcsDiff',
  useSendOpenCodeMessage: null,
  useSummarizeOpenCodeSession: 'useSummarizeRuntimeSession',
  useUpdateOpenCodeConfig: 'useUpdateRuntimeConfig',
  useUpdateOpenCodeSession: null,
};

const PKG_ROOT = join(import.meta.dir, '..');

test('no public name says "opencode" beyond the frozen pre-W4 list', () => {
  const found = new Set<string>();
  for (const snapshot of ['public-surface.snapshot.json', 'public-type-surface.snapshot.json']) {
    const surface = JSON.parse(readFileSync(join(import.meta.dir, snapshot), 'utf8')) as Record<
      string,
      string[]
    >;
    for (const names of Object.values(surface)) {
      for (const name of names) if (/opencode/i.test(name)) found.add(name);
    }
  }
  const added = [...found].filter((name) => !(name in PRE_W4_NAMES)).sort();
  expect(added, 'name these neutrally ("runtime"), not "opencode"').toEqual([]);
  expect([...found].sort()).toEqual(Object.keys(PRE_W4_NAMES).sort());
});

// One program over every public entry, read through the compiler the way an
// editor and the emitted `.d.ts` see the tags.
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
};
const entryFiles = Object.values(pkg.exports).map((file) => join(PKG_ROOT, file));
const program = ts.createProgram(entryFiles, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
  strict: false,
});
const checker = program.getTypeChecker();
const surface = new Map<string, ts.Symbol>();
for (const file of entryFiles) {
  const source = program.getSourceFile(file);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${file} has no module symbol`);
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    if (!surface.has(symbol.getName())) surface.set(symbol.getName(), symbol);
  }
}

function isDeprecated(name: string): boolean {
  const exported = surface.get(name);
  if (!exported) throw new Error(`${name} is not a public export of @kortix/sdk`);
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  return symbol.getJsDocTags(checker).some((tag) => tag.name === 'deprecated');
}

describe('every pre-W4 opencode name is deprecated for a neutral one', () => {
  test.each(Object.entries(PRE_W4_NAMES))('%s → %s', (old, neutral) => {
    expect(isDeprecated(old)).toBe(true);
    if (neutral !== null) expect(isDeprecated(neutral)).toBe(false);
  });
});
