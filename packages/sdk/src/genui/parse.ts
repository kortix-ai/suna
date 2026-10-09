import { createStreamingParser, type LibraryJSONSchema, type ValidationError } from '@openuidev/lang-core';

import { GENUI_LIBRARY } from './catalog';
import { shareNodes } from './share';
import { GENUI_SCHEMA_VERSION, type GenuiIssue, type GenuiNode, type GenuiParseResult } from './types';
import { sanitizeTree } from './validate';

let librarySchema: LibraryJSONSchema | null = null;
const schema = (): LibraryJSONSchema => (librarySchema ??= GENUI_LIBRARY.toJSONSchema());

const fromLangCore = (error: ValidationError): GenuiIssue => ({
  code: error.code === 'unknown-component' ? 'unknown-component' : 'schema',
  component: error.component,
  statementId: error.statementId,
  message: error.message,
});

const STATEMENT = /^\s*(\$?[A-Za-z_]\w*)\s*=/;

/**
 * The statement the model is still writing: OpenUI Lang puts one statement per line, so it is the
 * last non-empty line, when the input is incomplete. Null when that line has no `name =` yet.
 */
export function unfinishedStatement(code: string, incomplete: boolean): string | null {
  if (!incomplete) return null;
  const lines = code.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === '') continue;
    return STATEMENT.exec(lines[i]!)?.[1] ?? null;
  }
  return null;
}

export interface GenuiParser {
  /**
   * Parse the block's full text so far. lang-core diffs against the previous call and
   * parses only the new text. The same input returns the same result object.
   */
  update(code: string, streaming: boolean): GenuiParseResult;
}

export function createGenuiParser(version: number = GENUI_SCHEMA_VERSION): GenuiParser {
  if (version !== GENUI_SCHEMA_VERSION) {
    const unsupported: GenuiParseResult = {
      root: null,
      pending: [],
      issues: [{ code: 'version', message: `Block version ${version}; this client renders ${GENUI_SCHEMA_VERSION}` }],
      streaming: false,
    };
    return { update: () => unsupported };
  }

  const parser = createStreamingParser(schema(), 'Stack');
  let last: { code: string; streaming: boolean; result: GenuiParseResult } | null = null;
  let previousNodes: ReadonlyMap<string, GenuiNode> = new Map();

  return {
    update(code, streaming) {
      if (last && last.code === code && last.streaming === streaming) return last.result;
      const raw = parser.set(code);
      const sanitized = sanitizeTree(raw.root, { streaming, unfinished: unfinishedStatement(code, raw.meta.incomplete) });
      const shared = shareNodes(sanitized.root, previousNodes);
      previousNodes = shared.byId;
      const { issues } = sanitized;
      const result: GenuiParseResult = {
        root: shared.root,
        pending: raw.meta.unresolved,
        issues: [...raw.meta.errors.map(fromLangCore), ...issues],
        streaming,
      };
      const unsupported = raw.queryStatements.length + raw.mutationStatements.length + Object.keys(raw.stateDeclarations).length;
      if (unsupported > 0) {
        result.issues.push({ code: 'unsupported-statement', message: `${unsupported} Query/Mutation/state statement(s) ignored` });
      }
      if (!streaming && !shared.root) result.issues.push({ code: 'no-root', message: 'The block has no valid root Stack' });
      last = { code, streaming, result };
      return result;
    },
  };
}

/** One-shot parse of a finished block. */
export function parseGenui(code: string, version: number = GENUI_SCHEMA_VERSION): GenuiParseResult {
  return createGenuiParser(version).update(code, false);
}
