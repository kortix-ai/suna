import { autoClose, parseExpression, split, tokenize, walkAST, type ASTNode, type Token } from '@openuidev/lang-core';

import { GENUI_MAX_NODES, GENUI_MAX_SOURCE_CHARS } from './catalog';
import type { GenuiIssue } from './types';

/**
 * Deepest nesting (brackets plus reference hops) passed to lang-core, whose recursive parser and
 * materializer have no limit. Bracket-free operator chains (`!!!…`) are not counted: a stack
 * overflow there is caught in parse.ts and reported as `parse-failed`.
 */
const MAX_NESTING = 64;

/**
 * Most AST values (literals, arrays, objects, components) one block may expand to. Data references
 * are expanded as eagerly as components, so data fan-out needs its own bound. The largest catalog
 * payloads (a 365-point chart with 4 series, a 500-point route) are a few thousand values.
 */
const MAX_EXPANDED_VALUES = 50_000;

// ─── lang-core 0.3.1 `preprocess` (stripFences + stripComments) ────────────
// Copied verbatim in behavior because lang-core does not export it. The streaming parser runs it
// before it splits statements, so the pre-scan must see the same text. `@openuidev/lang-core` is
// pinned to 0.3.1 in package.json; re-check this copy when that pin moves.

function skipString(input: string, start: number): number {
  if (input[start] !== '"') return start;
  let i = start + 1;
  while (i < input.length) {
    const c = input[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else i++;
  }
  return i;
}

const isFence = (input: string, i: number) => input[i] === '`' && input[i + 1] === '`' && input[i + 2] === '`';

function stripFences(input: string): string {
  const blocks: string[] = [];
  let i = 0;
  while (i < input.length) {
    let fenceStart = -1;
    while (i < input.length) {
      const next = skipString(input, i);
      if (next > i) {
        i = next;
        continue;
      }
      if (isFence(input, i)) {
        fenceStart = i;
        break;
      }
      i++;
    }
    if (fenceStart === -1) break;
    let j = fenceStart + 3;
    while (j < input.length && input[j] !== '\n') j++;
    if (j >= input.length) {
      blocks.push(input.slice(fenceStart + 3).replace(/^[^\n]*\n?/, ''));
      break;
    }
    j++;
    let closePos = -1;
    let k = j;
    while (k < input.length) {
      const next = skipString(input, k);
      if (next > k) {
        k = next;
        continue;
      }
      if (isFence(input, k)) {
        closePos = k;
        break;
      }
      k++;
    }
    if (closePos === -1) {
      blocks.push(input.slice(j));
      break;
    }
    blocks.push(input.slice(j, closePos));
    i = closePos + 3;
  }
  if (blocks.length > 0) return blocks.join('\n');
  if (input.startsWith('```')) {
    let j = 3;
    while (j < input.length && input[j] !== '\n') j++;
    const body = input.slice(j < input.length ? j + 1 : 3);
    const trailing = body.lastIndexOf('```');
    return trailing === -1 ? body : body.slice(0, trailing);
  }
  return input;
}

function stripComments(input: string): string {
  let inStr: string | false = false;
  return input
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (inStr) {
          if (c === '\\' && i + 1 < line.length) {
            i++;
            continue;
          }
          if (c === inStr) inStr = false;
          continue;
        }
        if (c === '"' || c === "'") {
          inStr = c;
          continue;
        }
        if (c === '/' && line[i + 1] === '/') return line.substring(0, i).trimEnd();
        if (c === '#') return line.substring(0, i).trimEnd();
      }
      return line;
    })
    .join('\n');
}

const preprocess = (input: string) => stripComments(stripFences(input.trim())).trim();

// ─── Statements, split exactly as the streaming parser splits them ─────────

/** Deepest bracket nesting in `text`, outside strings. Stops counting past `MAX_NESTING`. */
function bracketDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let quote = '';
  let escaped = false;
  for (const c of text) {
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') {
      max = Math.max(max, ++depth);
      if (max > MAX_NESTING) return max;
    } else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
  }
  return max;
}

/**
 * Statement id → expression AST and tokens, as `createStreamingParser` would build them for
 * this full text: `preprocess`, completed statements cut at a newline at depth 0 (with ternary
 * continuation), each cut through lang-core's own `split(tokenize(…))`, then the pending tail
 * auto-closed. A later definition replaces an earlier one; a pending, incomplete redefinition of a
 * completed statement is ignored (a repeated id within the pending tail still replaces). Nothing is materialized.
 */
function statementsOf(cleaned: string): Map<string, { ast: ASTNode; tokens: Token[] }> {
  const statements = new Map<string, { ast: ASTNode; tokens: Token[] }>();
  const add = (text: string, skipCompleted: boolean) => {
    // lang-core skips only ids of completed statements; a repeated id inside the same text replaces.
    const completed = skipCompleted ? new Set(statements.keys()) : null;
    for (const raw of split(tokenize(text))) {
      if (completed?.has(raw.id)) continue;
      statements.set(raw.id, { ast: parseExpression(raw.tokens), tokens: raw.tokens });
    }
  };

  let depth = 0;
  let ternary = 0;
  let quote = '';
  let escaped = false;
  let start = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\' && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === '?' && depth === 0) ternary++;
    else if (c === ':' && depth === 0 && ternary > 0) ternary--;
    else if (c === '\n' && depth <= 0 && ternary <= 0) {
      let peek = i + 1;
      while (peek < cleaned.length && ' \t\r\n'.includes(cleaned[peek]!)) peek++;
      if (peek < cleaned.length && (cleaned[peek] === '?' || (cleaned[peek] === ':' && ternary > 0))) continue;
      const text = cleaned.slice(start, i).trim();
      if (text) add(text, false);
      start = i + 1;
    }
  }
  const pending = cleaned.slice(start).trim();
  if (pending) {
    const { text, wasIncomplete } = autoClose(pending);
    add(text, wasIncomplete);
  }
  return statements;
}

// lang-core token types for brackets (its `T` enum is a `const enum`, not available at runtime).
const OPEN = new Set([1, 3, 5]);
const CLOSE = new Set([2, 4, 6]);

/**
 * The issue that rejects `code` before lang-core sees it, or null.
 *
 * lang-core re-materializes a referenced statement at every use, without memoizing, and recurses
 * without a depth limit: a few hundred bytes of `a = Stack([b, b, …])` chains hang it. This sizes
 * the expanded tree from lang-core's own statements and ASTs with a memoized walk:
 * components (`GENUI_MAX_NODES`), all values (`MAX_EXPANDED_VALUES`), and nesting (`MAX_NESTING`).
 * A reference cycle rejects the block: lang-core cuts a cycle only on the current path, so a
 * memoized size could undercount it.
 */
export function expansionIssue(code: string): GenuiIssue | null {
  if (code.length > GENUI_MAX_SOURCE_CHARS) {
    return { code: 'too-large', message: `Block source is longer than ${GENUI_MAX_SOURCE_CHARS} characters` };
  }
  const tooDeep: GenuiIssue = { code: 'depth', message: `Brackets or references nest deeper than ${MAX_NESTING}` };
  const tooMany = (what: string): GenuiIssue => ({ code: 'too-many-nodes', message: `${what}; the block is not rendered` });

  const cleaned = preprocess(code);
  // lang-core's expression parser recurses per bracket: bound the nesting before it runs.
  if (bracketDepth(cleaned) > MAX_NESTING) return tooDeep;

  const own = new Map<string, { elements: number; values: number; depth: number; refs: string[] }>();
  for (const [id, { ast, tokens }] of statementsOf(cleaned)) {
    let elements = 0;
    let values = 0;
    const refs: string[] = [];
    walkAST(ast, (node) => {
      values++;
      if (node.k === 'Comp') elements++;
      else if (node.k === 'Ref' || node.k === 'RuntimeRef') refs.push(node.n);
    });
    let depth = 0;
    let max = 0;
    for (const token of tokens) {
      if (OPEN.has(token.t)) max = Math.max(max, ++depth);
      else if (CLOSE.has(token.t)) depth--;
    }
    own.set(id, { elements, values, depth: max, refs });
  }

  const nodeCap = GENUI_MAX_NODES + 1;
  const valueCap = MAX_EXPANDED_VALUES + 1;
  const sizes = new Map<string, { elements: number; values: number; depth: number }>();
  const path = new Set<string>();
  let cycle = false;
  const measure = (id: string): { elements: number; values: number; depth: number } => {
    const known = sizes.get(id);
    if (known) return known;
    // Every hop adds at least 1 to the depth, so a path this long is already too deep.
    if (path.size > MAX_NESTING) return { elements: 0, values: 0, depth: MAX_NESTING + 1 };
    path.add(id);
    const statement = own.get(id)!;
    let { elements, values } = statement;
    let below = 0;
    for (const ref of statement.refs) {
      if (!own.has(ref)) continue; // not written yet: lang-core leaves it unresolved
      if (path.has(ref)) {
        cycle = true;
        continue;
      }
      const child = measure(ref);
      elements = Math.min(nodeCap, elements + child.elements);
      values = Math.min(valueCap, values + child.values);
      below = Math.max(below, child.depth);
    }
    path.delete(id);
    const size = { elements, values, depth: statement.depth + 1 + below };
    sizes.set(id, size);
    return size;
  };

  // lang-core materializes the entry statement and, separately, every `$state` statement: the
  // `$state` sizes add up. Total work stays within twice the caps (the entry plus the sum).
  let stateElements = 0;
  let stateValues = 0;
  for (const id of own.keys()) {
    const size = measure(id);
    if (id.startsWith('$')) {
      stateElements = Math.min(nodeCap, stateElements + size.elements);
      stateValues = Math.min(valueCap, stateValues + size.values);
    }
    if (cycle) return tooMany('Block references form a cycle');
    if (stateElements >= nodeCap) return tooMany(`$state statements expand to more than ${GENUI_MAX_NODES} components`);
    if (stateValues >= valueCap) return tooMany(`$state statements expand to more than ${MAX_EXPANDED_VALUES} values`);
    if (size.depth > MAX_NESTING) return tooDeep;
    if (size.elements >= nodeCap) return tooMany(`Block expands to more than ${GENUI_MAX_NODES} components`);
    if (size.values >= valueCap) return tooMany(`Block expands to more than ${MAX_EXPANDED_VALUES} values`);
  }
  return null;
}
