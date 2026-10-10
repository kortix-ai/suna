import { createStreamingParser, type LibraryJSONSchema, type ValidationError } from '@openuidev/lang-core';

import { GENUI_LIBRARY, GENUI_MAX_NODES, GENUI_MAX_SOURCE_CHARS } from './catalog';
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

/** Deepest bracket nesting plus reference chain passed to lang-core, whose recursive-descent parser has no limit. */
const MAX_NESTING = 64;

/** At most this many issues per result; the first ones are kept. */
const MAX_ISSUES = 50;

const IDENTIFIER = /[A-Za-z_$]\w*/y;

/**
 * The issue that rejects `code` before lang-core sees it, or null.
 *
 * lang-core re-materializes a referenced statement at every use, without memoizing, and recurses
 * without a depth limit: a few hundred bytes of `a = Stack([b, b, …])` chains hang it, and deep
 * brackets overflow the stack. So: split statements exactly as lang-core does (`splitStatementSource`:
 * a newline at bracket depth 0, outside strings), collect each statement's references, and size the
 * expanded tree with a memoized walk.
 */
function rejection(code: string): GenuiIssue | null {
  if (code.length > GENUI_MAX_SOURCE_CHARS) {
    return { code: 'too-large', message: `Block source is longer than ${GENUI_MAX_SOURCE_CHARS} characters` };
  }
  const tooDeep: GenuiIssue = { code: 'depth', message: `Brackets or references nest deeper than ${MAX_NESTING}` };
  const statements = new Map<string, { refs: string[]; depth: number }>();
  let id: string | null = null;
  let refs: string[] = [];
  let maxDepth = 0;
  let first = true;
  const endStatement = () => {
    if (id !== null) statements.set(id, { refs, depth: maxDepth });
    id = null;
    refs = [];
    maxDepth = 0;
    first = true;
  };

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      first = false;
    } else if (c === '(' || c === '[' || c === '{') {
      if (++depth > MAX_NESTING) return tooDeep;
      maxDepth = Math.max(maxDepth, depth);
      first = false;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
    } else if (c === '\n' && depth === 0) {
      endStatement();
    } else if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') {
      IDENTIFIER.lastIndex = i;
      const word = IDENTIFIER.exec(code)?.[0];
      if (word) {
        let next = i + word.length;
        while (code[next] === ' ' || code[next] === '\t') next++;
        if (first && code[next] === '=' && code[next + 1] !== '=') id = word;
        else if (code[next] !== '(') refs.push(word);
        i += word.length - 1;
      }
      first = false;
    }
  }
  endStatement();

  // nodes: statements in the expanded tree, capped. depth: brackets plus one per reference hop.
  const cap = GENUI_MAX_NODES + 1;
  const sizes = new Map<string, { nodes: number; depth: number }>();
  const path = new Set<string>();
  const measure = (name: string): { nodes: number; depth: number } => {
    const known = sizes.get(name);
    if (known) return known;
    // Every hop adds at least 1 to the depth, so a path this long is already too deep.
    if (path.size > MAX_NESTING) return { nodes: 1, depth: MAX_NESTING + 1 };
    path.add(name);
    const statement = statements.get(name)!;
    let nodes = 1;
    let below = 0;
    for (const ref of statement.refs) {
      if (!statements.has(ref) || path.has(ref)) continue; // lang-core blocks a cycle on the current path
      const child = measure(ref);
      nodes = Math.min(cap, nodes + child.nodes);
      below = Math.max(below, child.depth);
    }
    path.delete(name);
    const size = { nodes, depth: statement.depth + 1 + below };
    sizes.set(name, size);
    return size;
  };
  for (const name of statements.keys()) {
    const size = measure(name);
    if (size.depth > MAX_NESTING) return tooDeep;
    if (size.nodes >= cap) {
      return { code: 'too-many-nodes', message: `Block expands to more than ${GENUI_MAX_NODES} nodes; it is not rendered` };
    }
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

  let parser = createStreamingParser(schema(), 'Stack');
  let last: { code: string; streaming: boolean; result: GenuiParseResult } | null = null;
  let previousNodes: ReadonlyMap<string, GenuiNode> = new Map();

  const parse = (code: string, streaming: boolean): GenuiParseResult => {
    const rejected = rejection(code);
    if (rejected) return { root: null, pending: [], issues: [rejected], streaming };
    let raw: ReturnType<typeof parser.set>;
    let sanitized: ReturnType<typeof sanitizeTree>;
    try {
      raw = parser.set(code);
      sanitized = sanitizeTree(raw.root, { streaming, unfinished: unfinishedStatement(code, raw.meta.incomplete) });
    } catch (error) {
      // The parser's state is unknown after a throw: start the next call from scratch.
      parser = createStreamingParser(schema(), 'Stack');
      previousNodes = new Map();
      const message = error instanceof Error ? error.message : String(error);
      return { root: null, pending: [], issues: [{ code: 'parse-failed', message: message.slice(0, 200) }], streaming };
    }
    const shared = shareNodes(sanitized.root, previousNodes);
    previousNodes = shared.byId;
    const issues = [...raw.meta.errors.map(fromLangCore), ...sanitized.issues];
    const unsupported = raw.queryStatements.length + raw.mutationStatements.length + Object.keys(raw.stateDeclarations).length;
    if (unsupported > 0) {
      issues.push({ code: 'unsupported-statement', message: `${unsupported} Query/Mutation/state statement(s) ignored` });
    }
    if (!streaming && !shared.root) issues.push({ code: 'no-root', message: 'The block has no valid root Stack' });
    return { root: shared.root, pending: raw.meta.unresolved, issues: issues.slice(0, MAX_ISSUES), streaming };
  };

  return {
    update(code, streaming) {
      if (last && last.code === code && last.streaming === streaming) return last.result;
      const result = parse(code, streaming);
      last = { code, streaming, result };
      return result;
    },
  };
}

/** One-shot parse of a finished block. */
export function parseGenui(code: string, version: number = GENUI_SCHEMA_VERSION): GenuiParseResult {
  return createGenuiParser(version).update(code, false);
}
