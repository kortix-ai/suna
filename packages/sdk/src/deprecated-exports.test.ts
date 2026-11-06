import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';
import * as kortixMaster from './core/runtime/kortix-master';
import * as kortixMasterHooks from './react/use-kortix-master';

/**
 * Exports that stay public for now but must carry `@deprecated`, so a
 * consumer's editor flags every call site before the name is removed. A
 * first-party host still calls each of them. The tag is read from the source
 * through the TypeScript compiler, the same way an editor and the emitted
 * `.d.ts` see it.
 */

/**
 * The Kortix message id format and its clock arithmetic. They are current, not
 * deprecated: the pi harness (`apps/kortix-sandbox-agent-server/src/harness/pi/message-id.ts`)
 * mints its reply ids with them and apps/api places prompts with them.
 */
const MESSAGE_ID_EXPORTS = [
  'mintWireMessageId',
  'WIRE_MESSAGE_ID',
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

/** Public transcript sharing was removed server-side (KRTX-2358): the API
 *  serves no `/v1/public/session-shares/**` route and rejects transcript
 *  creates. The client names stay exported until the next major. */
const TRANSCRIPT_SHARE_EXPORTS = [
  'findActiveTranscriptShare',
  'getPublicSessionShare',
  'getPublicSessionShareMessages',
  'PublicSessionShareError',
  'PublicSessionShareMeta',
  'PublicSessionTranscript',
  'PublicSessionTranscriptMessage',
  'PublicSessionTranscriptToolCall',
];

/**
 * The workspace rename (PR #11857): each older `Project*` / `Account*` name
 * that has an exact `Workspace*` equivalent carries `@deprecated` naming the
 * replacement. Compatibility is PERMANENT: these names are never removed, so
 * the tag says `Kept permanently.` and never `Removed in the next major.`.
 * A name with no exact equivalent (the IAM functions, until the one
 * workspace scope lands) is not deprecated. Every project-named export is
 * covered by `workspace-names.test.ts`.
 */
const WORKSPACE_EQUIVALENTS: Record<string, string> = {
  updateProject: 'updateWorkspace',
  updateAccountName: 'updateWorkspace',
  listAccountMembers: 'listWorkspaceMembers',
  inviteAccountMember: 'inviteWorkspaceMember',
  removeAccountMember: 'removeWorkspaceMember',
  updateAccountMemberRole: 'updateWorkspaceMemberRole',
  listAccountInvites: 'listWorkspaceInvites',
  cancelAccountInvite: 'cancelWorkspaceInvite',
  resendAccountInvite: 'resendWorkspaceInvite',
  leaveAccount: 'leaveWorkspace',
  listAccountTokens: 'listWorkspaceTokens',
  revokeAccountToken: 'revokeWorkspaceToken',
};

const KEPT_PERMANENTLY = /Kept permanently\./;

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

const REMOVED_IN_NEXT_MAJOR = /Removed in the next major\./;

describe('deprecated exports', () => {
  test('the kortix-master sweep is not empty', () => {
    expect(KORTIX_MASTER_EXPORTS.length).toBeGreaterThan(100);
  });

  test.each(KORTIX_MASTER_EXPORTS)('%s is @deprecated', (name) => {
    expect(isDeprecated(name)).toBe(true);
  });

  test.each(TRANSCRIPT_SHARE_EXPORTS)(
    '%s is @deprecated and removed in the next major',
    (name) => {
      expect(deprecation(name)).toMatch(REMOVED_IN_NEXT_MAJOR);
    },
  );

  test.each(Object.entries(WORKSPACE_EQUIVALENTS))(
    '%s is @deprecated in favour of %s and kept permanently',
    (name, replacement) => {
      const text = deprecation(name);
      expect(text).toContain(`\`${replacement}`);
      expect(text).toMatch(KEPT_PERMANENTLY);
      expect(text).not.toMatch(REMOVED_IN_NEXT_MAJOR);
    },
  );

  test.each([...new Set(Object.values(WORKSPACE_EQUIVALENTS))])('%s, the workspace name, is current', (name) => {
    expect(isDeprecated(name)).toBe(false);
  });

  // createAccountToken mints a PERSONAL key (acts as the person in every
  // workspace); createWorkspaceToken mints a key bound to one workspace.
  // Different reach: not an equivalent.
  // The project names (getProject, listProjectsForAccount, …) are covered by
  // workspace-names.test.ts since the Naming stage (2026-11-06): each has a
  // workspace twin or a named replacement.
  test.each(['KortixAccount', 'listAccounts', 'createAccountToken'])(
    '%s has no exact workspace equivalent and stays current',
    (name) => {
      expect(isDeprecated(name)).toBe(false);
    },
  );

  test.each(MESSAGE_ID_EXPORTS)('%s stays current (the Kortix message id format)', (name) => {
    expect(isDeprecated(name)).toBe(false);
  });
});
