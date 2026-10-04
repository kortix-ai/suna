import { describe, expect, test } from 'bun:test';
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

function isDeprecated(name: string): boolean {
  const exported = surface.get(name);
  if (!exported) throw new Error(`${name} is not exported from @kortix/sdk or @kortix/sdk/react`);
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  return symbol.getJsDocTags(checker).some((tag) => tag.name === 'deprecated');
}

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

  test.each(['mintWireMessageId', 'WIRE_MESSAGE_ID'])('%s stays current (the Kortix message id format)', (name) => {
    expect(isDeprecated(name)).toBe(false);
  });
});
