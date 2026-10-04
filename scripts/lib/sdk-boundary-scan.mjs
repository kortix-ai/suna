/**
 * The scan scaffold both app SDK-boundary lints share (`apps/web/scripts/
 * sdk-boundary.mjs` and `apps/whitelabel-demo/scripts/sdk-boundary.mjs`).
 * One directory walker, one line counter, one static-fetch-target extractor —
 * hoisted here so the two lints cannot drift apart in how they read source.
 */

import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Every source file under `root`, recursively, in directory order.
 * `skip` drops files before they are collected (web skips its test files).
 */
export function sourceFiles(
  root,
  { extensions, skip = null, sort = false },
) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        visit(path);
        continue;
      }
      if (!extensions.has(extname(path))) continue;
      if (skip && skip(path)) continue;
      files.push(path);
    }
  };
  visit(root);
  return sort ? files.sort() : files;
}

/** 1-based line of a source index, for violation reports. */
export function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * The static target of a `fetch(...)` from the text right after `fetch(`.
 *
 * A plain quote returns the whole string. A template literal is judged by its
 * STATIC PREFIX — the text before the first interpolation. `/api/x?id=${v}` is
 * as verifiable as the string form; a template whose BASE is dynamic
 * (`${base}/api/x`) still has an empty prefix and is correctly rejected.
 * Without this, an app route with query params could not be called at all.
 */
export function staticFetchTarget(expression) {
  const quote = expression[0];
  if (quote === "'" || quote === '"') {
    const end = expression.indexOf(quote, 1);
    if (end > 0) return expression.slice(1, end);
    return null;
  }
  if (quote === '`') {
    const end = expression.indexOf('`', 1);
    const raw = end > 0 ? expression.slice(1, end) : expression.slice(1);
    const interp = raw.indexOf('${');
    const prefix = interp >= 0 ? raw.slice(0, interp) : raw;
    return prefix.length > 0 ? prefix : null;
  }
  return null;
}
