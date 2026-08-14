// Maps a request path from the packaged SPA onto a file in the static export.
//
// The desktop bundle is `apps/web` exported with `output: 'export'`
// (apps/web/desktop/build.mjs). Real project and session ids do not exist at
// build time, so every dynamic segment is exported ONCE against the literal
// `__shell__`, and this resolver serves that shell for whatever id the user
// actually opens. apps/web/desktop/nav-shim.tsx then recovers the real param
// from the URL, so the page renders the right project.
//
// Resolution is segment-by-segment rather than one big regex: at each level an
// exact directory match wins, and `__shell__` is the fallback. That is the same
// precedence Next itself uses for static-over-dynamic, so a real route named
// like a param cannot be shadowed.
//
// It deliberately also resolves the RSC payload files Next emits for client
// navigation (`__next.*.txt`). Those are named after the route PATTERN
// (`__next.projects.$d$id.sessions.$d$sessionId.__PAGE__.txt`), not the param
// values, so the same segment rewrite reaches them with no special case.

const fs = require('node:fs');
const path = require('node:path');

const SHELL_SEGMENT = '__shell__';

/**
 * Resolve a URL pathname to an absolute file path inside the export.
 *
 * @param {string} root Absolute path to the exported `out/` directory.
 * @param {string} pathname URL pathname, already decoded.
 * @returns {string | null} Absolute file path, or null when nothing matches.
 */
function resolveSpaFile(root, pathname) {
  const segments = pathname.split('/').filter(Boolean);

  // A trailing filename (an asset, or one of Next's `__next.*.txt` RSC payloads)
  // is resolved as a file inside the final directory. A bare route path is
  // resolved as a page.
  const last = segments[segments.length - 1];
  const looksLikeFile = last !== undefined && last.includes('.');

  if (looksLikeFile) {
    const dir = descend(root, segments.slice(0, -1));
    return dir === null ? pick(root, path.join(root, last)) : pick(root, path.join(dir, last));
  }

  if (segments.length === 0) return pick(root, path.join(root, 'index.html'));

  const dir = descend(root, segments.slice(0, -1));
  if (dir === null) return null;

  // The final segment is a page. Order matters: an EXACT match must beat the
  // shell, or a real route whose name looks like an id (`/projects/start`) would
  // render as a project. Next emits pages as flat `<name>.html`, but a route
  // with children can also be a directory holding `index.html`.
  const leaf = segments[segments.length - 1];
  return (
    pick(root, path.join(dir, `${leaf}.html`)) ??
    pick(root, path.join(dir, leaf, 'index.html')) ??
    pick(root, path.join(dir, `${SHELL_SEGMENT}.html`)) ??
    pick(root, path.join(dir, SHELL_SEGMENT, 'index.html'))
  );
}

/**
 * Walk intermediate path segments to a directory, substituting the exported
 * shell for any segment that is a runtime value (a project or session id).
 *
 * @returns {string | null} Absolute directory, or null when the path does not exist.
 */
function descend(root, segments) {
  let dir = root;
  for (const segment of segments) {
    const exact = path.join(dir, segment);
    if (isDirectory(exact)) {
      dir = exact;
      continue;
    }
    const shell = path.join(dir, SHELL_SEGMENT);
    if (isDirectory(shell)) {
      dir = shell;
      continue;
    }
    return null;
  }
  return dir;
}

/** The file if it exists and is inside the root, else null. */
function pick(root, file) {
  if (!isWithin(root, file)) return null;
  return isFile(file) ? file : null;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Guard against `..` escaping the export root. */
function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { resolveSpaFile, SHELL_SEGMENT };
