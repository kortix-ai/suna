import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

// The web app renders sessions from the session log (`kortix.session/2`, P5): a host file
// reads blocks (`SessionLogMessage`, `ToolCallBlock`, `SessionLogTurn`) through
// `useSessionLog` / `useSessionLogThread` and the SDK's block turn layer. A host file that
// imports a v1 part or turn type, or a v1 helper that takes v1 rows, depends on the shape
// P8.4 deletes. Session Log Plan P5.7; P5.2c's done-when for `features/session`.
//
// Scope: every tracked `.ts`/`.tsx` under apps/web/src. Not scanned: tests (they build v1
// fixtures on purpose), `apps/web/src/ui/` and the shims (a file that only re-exports an SDK
// module, such as `lib/iam-client.ts`): they are the SDK surface. An import from any of them
// counts as an import from the SDK.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WEB_SRC = 'apps/web/src';

/** v1 part and turn types, and the v1 helpers that take or return v1 rows or parts. */
const V1_NAMES = new Set([
  // types
  'MessageWithParts', 'Part', 'ToolPart', 'TextPart', 'ReasoningPart', 'FilePart', 'PatchPart',
  'SnapshotPart', 'StepStartPart', 'StepFinishPart', 'CompactionPart', 'AgentPart', 'SubtaskPart',
  'RetryPart', 'Turn', 'TurnLike', 'ClassifiedTurn', 'ClassifiedPart',
  // turn helpers (replaced by the block turn layer, `sessionLog*`)
  'groupMessagesIntoTurns', 'collectTurnParts', 'getTurnStatus', 'getTurnError', 'getTurnErrorDetails',
  'getTurnErrorRawText', 'getTurnCost', 'findLastTextPart', 'getShellModePart', 'splitTurnWork',
  'groupShowSegments', 'segmentTurn', 'compactionTurnInfo', 'getWorkingState', 'hasRetryingAssistantTurn',
  'classifyTurn', 'classifyPart',
  // part helpers
  'getChildSessionToolParts', 'getChildSessionError', 'isToolPart', 'isTextPart', 'isReasoningPart',
  'isPatchPart', 'isSnapshotPart', 'isCompactionPart', 'toolCallBlock',
  // v1 row hooks
  'useRuntimeMessages', 'useOpenCodeMessages',
]);

/** Each entry is `<file>: <name>` with the reason it stays. Remove it with the reason. */
const ALLOWED: Record<string, string> = {};

const SDK_PACKAGE = /^@kortix\/sdk(?:\/|$)/;
const NAMED = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const NAMESPACE = /\bimport\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s*['"]([^'"]+)['"]/g;
const STAR_EXPORT = /\bexport\s+(?:type\s+)?\*\s+(?:as\s+\w+\s+)?from\s*['"]([^'"]+)['"]/g;
const INLINE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)\.(\w+)/g;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** The repo path a web import specifier names, or null for a package outside the app. */
function resolveWeb(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith('@/')
    ? posix.join(WEB_SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? posix.join(dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

const shims = new Map<string, boolean>();
/** A file whose code is only re-exports of SDK modules (`export * from '@kortix/sdk'`). */
function isShim(file: string): boolean {
  let known = shims.get(file);
  if (known === undefined) {
    const code = readFileSync(join(REPO_ROOT, file), 'utf8').replace(COMMENTS, '');
    const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
    known =
      statements.length > 0 &&
      statements.some((s) => s.startsWith('export *')) &&
      statements.every((s) => {
        const from = /^export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]$/.exec(s);
        return !!from && isSdkModule(from[1]!, file);
      });
    shims.set(file, known);
  }
  return known;
}

/** `@kortix/sdk*`, the `src/ui/` shim (by `@/ui` or a relative path), or a shim of either. */
function isSdkModule(specifier: string, fromFile: string): boolean {
  if (SDK_PACKAGE.test(specifier)) return true;
  const file = resolveWeb(specifier, fromFile);
  return !!file && (file.startsWith(`${WEB_SRC}/ui/`) || isShim(file));
}

/** Every `<name> (<module>)` a source text imports from the SDK that is a v1 name. */
function v1Imports(text: string, file: string): string[] {
  const found: string[] = [];
  for (const [, names, module] of text.matchAll(NAMED)) {
    if (!isSdkModule(module!, file)) continue;
    for (const raw of names!.replace(COMMENTS, '').split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (V1_NAMES.has(name)) found.push(`${name} (${module})`);
    }
  }
  for (const [, module] of text.matchAll(NAMESPACE)) {
    if (isSdkModule(module!, file)) found.push(`* (${module})`);
  }
  // A host file that re-exports a whole SDK module re-exports its v1 names (a pure shim is
  // the SDK surface and is not scanned).
  for (const [, module] of text.matchAll(STAR_EXPORT)) {
    if (isSdkModule(module!, file)) found.push(`export * (${module})`);
  }
  for (const [, module, name] of text.matchAll(INLINE)) {
    if (isSdkModule(module!, file) && V1_NAMES.has(name!)) found.push(`${name} (${module})`);
  }
  return found;
}

function hostFiles(): string[] {
  return execFileSync('git', ['ls-files', WEB_SRC], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !/\.test\.tsx?$|\/__tests__\//.test(file))
    .filter((file) => !file.startsWith(`${WEB_SRC}/ui/`))
    .filter((file) => !isShim(file));
}

describe('web host files import no v1 part or turn type', () => {
  const at = `${WEB_SRC}/features/session/tool/tools/task-tool.tsx`;

  it('flags a planted import, an aliased one, a namespace import and an inline type import', () => {
    const planted = [
      "import type { MessageWithParts, SessionLogMessage } from '@/ui';",
      "import { toolCallBlock as toBlock } from '@kortix/sdk';",
      "import * as sdk from '@kortix/sdk/react';",
      "type Row = import('@/ui').Part;",
      "import { Part } from './local-part';",
    ].join('\n');
    expect(v1Imports(planted, at)).toEqual([
      'MessageWithParts (@/ui)',
      'toolCallBlock (@kortix/sdk)',
      '* (@kortix/sdk/react)',
      'Part (@/ui)',
    ]);
  });

  it('flags an import through a shim, a relative path to ui/, an export * and a name behind a comment', () => {
    const planted = [
      "import { ToolPart } from '@/lib/iam-client';",
      "import { useRuntimeMessages } from '@/hooks/tunnel/use-tunnel';",
      "import type { TextPart } from '../../../../ui';",
      "export * from '@/ui';",
      'import {\n  // a comment\n  SessionLogBlock, /* another */ Turn,\n} from "@kortix/sdk";',
    ].join('\n');
    expect(v1Imports(planted, at)).toEqual([
      'ToolPart (@/lib/iam-client)',
      'useRuntimeMessages (@/hooks/tunnel/use-tunnel)',
      'TextPart (../../../../ui)',
      'Turn (@kortix/sdk)',
      'export * (@/ui)',
    ]);
  });

  it('reads a pure re-export as a shim and a file with its own code as host code', () => {
    expect(isShim(`${WEB_SRC}/lib/iam-client.ts`)).toBe(true);
    expect(isShim(`${WEB_SRC}/hooks/tunnel/use-tunnel.ts`)).toBe(true);
    expect(isShim(at)).toBe(false);
  });

  it('names only what the SDK or the web shim exports, so the list cannot go stale', () => {
    const surfaces = [
      'packages/sdk/src/public-surface.snapshot.json',
      'packages/sdk/src/public-type-surface.snapshot.json',
      `${WEB_SRC}/ui/types.ts`,
    ].map((file) => readFileSync(join(REPO_ROOT, file), 'utf8'));
    const missing = [...V1_NAMES].filter((name) => !surfaces.some((s) => new RegExp(`\\b${name}\\b`).test(s)));
    expect(missing).toEqual([]);
  });

  it('holds for every host file under apps/web/src', () => {
    const files = hostFiles();
    expect(files.length).toBeGreaterThan(500);
    const violations = files.flatMap((file) =>
      v1Imports(readFileSync(join(REPO_ROOT, file), 'utf8'), file)
        .map((hit) => `${file}: ${hit}`)
        .filter((line) => !(line.replace(/ \(.*\)$/, '') in ALLOWED)),
    );
    expect(violations).toEqual([]);
  });
});
