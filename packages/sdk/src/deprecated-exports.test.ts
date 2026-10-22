import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import * as kortixMaster from './core/runtime/kortix-master';
import * as kortixMasterHooks from './react/use-kortix-master';

/**
 * Exports that stay public until the next major but must carry `@deprecated`,
 * so a consumer's editor flags every call site before the name is removed.
 * The tag is read from the source through the TypeScript compiler, the same
 * way an editor and the emitted `.d.ts` see it.
 */

/** No host uses them. Each wraps an OpenCode-only REST route. */
const UNUSED_RUNTIME_EXPORTS = [
  'useOpenCodeMcpStatus',
  'useAddMcpServer',
  'useConnectMcpServer',
  'useDisconnectMcpServer',
  'useMcpAuthStart',
  'useMcpAuthCallback',
  'useMcpAuthRemove',
  'useShareSession',
  'useUnshareSession',
  'useUpdatePart',
  'useDeletePart',
  'useOpenCodeSkills',
  'useOpenCodeToolIds',
  'useOpenCodeProjects',
  'useDeleteOpenCodeSession',
  'getRuntimeProviderAuthMethods',
  'authorizeRuntimeProvider',
  'completeRuntimeProviderOAuth',
  'setRuntimeProviderApiKey',
  'getRuntimeConfig',
  'updateRuntimeConfig',
  'refreshRuntimeConfiguration',
];

/**
 * The message-id clock arithmetic: an ordering detail of OpenCode's ids that
 * clients must not depend on. Kortix message ids are opaque; `mintWireMessageId`
 * and `WIRE_MESSAGE_ID` stay.
 */
const MESSAGE_ID_CLOCK_EXPORTS = [
  'WIRE_ID_TIME_SCALE',
  'WIRE_ID_TIME_MASK',
  'WIRE_ID_CLOCK_TOLERANCE',
  'WIRE_ID_BACKDATE_MS',
  'wireIdClock',
  'wireIdClockAt',
  'wireIdClockDelta',
  'maxWireIdClock',
  'isWireIdAheadOf',
  'newestWireIdClock',
  'mintWireMessageIdAbove',
  'MintWireMessageIdAboveInput',
  'MintedWireMessageId',
];

/** The sandbox daemon serves none of `/kortix/tasks|tickets|projects|services`: every call answers 404. */
const functionNames = (module: Record<string, unknown>) =>
  Object.keys(module).filter((name) => typeof module[name] === 'function');
const KORTIX_MASTER_EXPORTS = [...functionNames(kortixMaster), ...functionNames(kortixMasterHooks)];

/**
 * The next-major removal list (R6.10). `packages/sdk/CHANGELOG.md` names each
 * one with its replacement. No first-party host uses any of them. Each tag
 * must say `Removed in the next major.`, so the major is a deletion, not an
 * investigation.
 */

/** Kortix orders prompts server-side; the client queue reducers are unused. */
const MESSAGE_QUEUE_EXPORTS = [
  'claimNext',
  'completeInFlight',
  'createSessionQueue',
  'editQueued',
  'enqueue',
  'failInFlight',
  'removeQueued',
  'reorderQueued',
  'retryFailed',
  'QueuedMessage',
  'QueuedMessageInput',
  'SessionQueue',
];

/** Every export of these modules wraps a route the API removed. The modules go whole. */
const RETIRED_MODULES = [
  'react/use-admin-analytics.ts',
  'react/use-admin-feedback.ts',
  'react/use-system-status.ts',
  'react/use-admin-billing.ts',
];

/** Retired hooks in modules that also hold live hooks. Each fails with `ENDPOINT_RETIRED`. */
const RETIRED_HOOKS = [
  'useAdminSandboxDetail',
  'useAdminSandboxHealth',
  'useAdminSandboxHealthBatch',
  'useAdminSandboxExec',
  'useAdminSandboxAction',
  'useAdminSandboxRepair',
  'useDeleteAdminSandbox',
  'useAdminAccountSandboxes',
  'useCreateTunnelConnection',
  'useTunnelPermissions',
  'useGrantTunnelPermission',
  'useRevokeTunnelPermission',
  'useTunnelPermissionRequests',
  'useApprovePermissionRequest',
  'useDenyPermissionRequest',
  'useTunnelAuditLogs',
];

/** Types and helpers only the retired hooks above use. */
const RETIRED_HOOK_TYPES = [
  'AdminSandboxDetail',
  'ProviderMachineDetail',
  'AdminInstanceLayerStatus',
  'AdminInstanceLayerAction',
  'AdminInstanceLayerHealth',
  'AdminSandboxHealth',
  'AdminSandboxHealthBatchResponse',
  'ExecResult',
  'ProxyTokenResult',
  'fetchAdminSandboxProxyToken',
  'AdminAccountSandbox',
];

/** `react/use-opencode-sessions` hooks no first-party host calls. */
const UNUSED_SESSION_HOOKS = [
  'useOpenCodeRuntimeReady',
  'useOpenCodeSessions',
  'useOpenCodeSession',
  'useCreateOpenCodeSession',
  'useUpdateRuntimeSession',
  'useUpdateOpenCodeSession',
  'useDeleteOpenCodeSession',
  'useRuntimeSessionDiff',
  'useOpenCodeSessionDiff',
  'useOpenCodeSessionTodo',
  'useSummarizeOpenCodeSession',
  'useInitSession',
  'useOpenCodeMessages',
  'useSendRuntimeMessage',
  'useSendOpenCodeMessage',
  'useAbortOpenCodeSession',
  'useRuntimeAgent',
  'useOpenCodeAgents',
  'useOpenCodeAgent',
  'useRuntimeTools',
  'useOpenCodeTools',
  'useOpenCodeToolIds',
  'useOpenCodeSkills',
  'useOpenCodeProjects',
  'useOpenCodeCurrentProject',
  'useOpenCodePathInfo',
  'useOpenCodeCommands',
  'useExecuteOpenCodeCommand',
  'useOpenCodeProviders',
  'useShareSession',
  'useUnshareSession',
  'useUpdatePart',
  'useDeletePart',
  'useOpenCodeVcsDiff',
];

/** Subpaths removed in the next major: the 20 legacy shims, 4 unused internal stores, the queue. */
const NEXT_MAJOR_SUBPATHS = [
  './opencode-client',
  './config',
  './auth',
  './api-client',
  './projects-client',
  './feature-flags',
  './fresh-sessions',
  './instance-routes',
  './opencode-errors',
  './platform-client',
  './event-stream',
  './files',
  './session',
  './session/url',
  './turns',
  './sync-store',
  './server-store',
  './sandbox-connection-store',
  './opencode-pending-store',
  './idb-sync-cache',
  './internal/sync-store',
  './internal/server-store',
  './internal/sandbox-connection-store',
  './internal/opencode-pending-store',
  './message-queue',
];

const program = ts.createProgram([join(import.meta.dir, 'index.ts'), join(import.meta.dir, 'react/index.ts')], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  skipLibCheck: true,
  noEmit: true,
});
const checker = program.getTypeChecker();

function exportedSymbols(entry: string): Map<string, ts.Symbol> {
  const file = program.getSourceFile(join(import.meta.dir, entry));
  if (!file) throw new Error(`${entry} is not in the program`);
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (!moduleSymbol) throw new Error(`${entry} has no module symbol`);
  return new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol]));
}

const surface = new Map([...exportedSymbols('index.ts'), ...exportedSymbols('react/index.ts')]);

function deprecatedTag(exported: ts.Symbol): ts.JSDocTagInfo | undefined {
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  return symbol.getJsDocTags(checker).find((tag) => tag.name === 'deprecated');
}

function isDeprecated(name: string): boolean {
  const exported = surface.get(name);
  if (!exported) throw new Error(`${name} is not exported from @kortix/sdk or @kortix/sdk/react`);
  return deprecatedTag(exported) !== undefined;
}

/** The `@deprecated` text of a public name; '' when it has no tag. */
function deprecation(name: string): string {
  const exported = surface.get(name);
  if (!exported) throw new Error(`${name} is not exported from @kortix/sdk or @kortix/sdk/react`);
  return ts.displayPartsToString(deprecatedTag(exported)?.text ?? []);
}

const RETIRED_MODULE_EXPORTS = RETIRED_MODULES.flatMap((entry) => [...exportedSymbols(entry).keys()]);
const REMOVED_IN_NEXT_MAJOR = /Removed in the next major\./;

describe('deprecated exports', () => {
  test('the kortix-master sweep is not empty', () => {
    expect(KORTIX_MASTER_EXPORTS.length).toBeGreaterThan(100);
  });

  test.each(UNUSED_RUNTIME_EXPORTS)('%s is @deprecated', (name) => {
    expect(isDeprecated(name)).toBe(true);
  });

  test.each(KORTIX_MASTER_EXPORTS)('%s is @deprecated', (name) => {
    expect(isDeprecated(name)).toBe(true);
  });

  test.each(MESSAGE_ID_CLOCK_EXPORTS)('%s is @deprecated', (name) => {
    expect(isDeprecated(name)).toBe(true);
  });

  test('the retired-module sweep is not empty', () => {
    expect(RETIRED_MODULE_EXPORTS.length).toBeGreaterThan(80);
  });

  test.each([...MESSAGE_QUEUE_EXPORTS, ...RETIRED_MODULE_EXPORTS, ...RETIRED_HOOKS, ...RETIRED_HOOK_TYPES, ...UNUSED_SESSION_HOOKS])(
    '%s is @deprecated and removed in the next major',
    (name) => {
      expect(deprecation(name)).toMatch(REMOVED_IN_NEXT_MAJOR);
    },
  );

  test.each(NEXT_MAJOR_SUBPATHS)('subpath %s is @deprecated and removed in the next major', (subpath) => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    const file = pkg.exports[subpath];
    expect(file).toBeDefined();
    const header = readFileSync(join(import.meta.dir, '..', file), 'utf8').match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? '';
    expect(header).toContain('@deprecated');
    expect(header).toMatch(REMOVED_IN_NEXT_MAJOR);
  });

  test.each(['mintWireMessageId', 'WIRE_MESSAGE_ID'])('%s stays current (the Kortix message id format)', (name) => {
    expect(isDeprecated(name)).toBe(false);
  });
});
