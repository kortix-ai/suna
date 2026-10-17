import { isUnderSandboxRoot } from '@kortix/sdk';

import type { MdNode } from './setup-link-blocks';

/**
 * Agents link a file they wrote in three shapes: `sandbox:/workspace/a.docx`
 * (GPT models), `file:///workspace/a.docx`, or a path (`/workspace/a.docx`,
 * `out/a.docx`). Sanitize strips the `sandbox:` and `file:` schemes and
 * rehype-harden refuses a bare relative path, so each one rendered as
 * `label [blocked]`. `remarkWorkspaceFileLinks` rewrites them to this fragment
 * before either gate runs. A fragment passes both unchanged and never
 * navigates; the `a` renderer turns it into a file-preview control.
 */
const FILE_LINK_HREF = '#kortix-file:';
const FILE_SCHEME = /^(?:sandbox|file|computer):(?:\/\/[^/]*)?/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves a document-relative href against the directory of the document
 * that contains the link, lexically (`.` and `..` only — no filesystem
 * access). The caller validates the normalized result against sandbox roots.
 */
function resolveDocumentRelative(baseDir: string, href: string): string | null {
  const segments = baseDir.split('/');
  for (const part of href.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length <= 1) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/') || null;
}

/**
 * The workspace path a link points at, or `null` for any other link. With
 * `baseDir` — the directory of the document that contains the link — a bare
 * relative href resolves against that directory; traversal that escapes the
 * root stays `null` and rehype-harden keeps blocking the link.
 */
export function workspaceFileLinkPath(url: string | undefined, baseDir?: string): string | null {
  let path = url?.trim() ?? '';
  if (FILE_SCHEME.test(path)) {
    path = path.replace(FILE_SCHEME, '');
  } else if (ANY_SCHEME.test(path) || /^(?:[#?]|\/\/)/.test(path)) {
    return null;
  } else if (path.startsWith('/') && !isUnderSandboxRoot(path)) {
    // A root-relative path outside the sandbox roots is an app route.
    return null;
  }
  path = path.replace(/[?#].*$/, '').replace(/^(?:\.\/)+/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray `%` is a literal character in a file name.
  }
  if (baseDir && path) {
    const resolved = path.startsWith('/')
      ? resolveDocumentRelative('', path)
      : resolveDocumentRelative(baseDir, path);
    return resolved && isUnderSandboxRoot(resolved) ? resolved : null;
  }
  return path || null;
}

export function parseFileLinkHref(href: string | undefined, document = false): string | null {
  if (!href?.startsWith(FILE_LINK_HREF)) return null;
  try {
    const path = decodeURIComponent(href.slice(FILE_LINK_HREF.length));
    if (!document) return path || null;
    const resolved = resolveDocumentRelative('', path);
    return path.startsWith('/') && resolved && isUnderSandboxRoot(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function rewriteFileLinks(node: MdNode, baseDir?: string): void {
  if (node.type === 'link' || node.type === 'definition') {
    const path = workspaceFileLinkPath(node.url, baseDir);
    if (path) node.url = `${FILE_LINK_HREF}${encodeURIComponent(path)}`;
  }
  node.children?.forEach((child) => rewriteFileLinks(child, baseDir));
}

/** `baseDir`: the directory of the document being rendered, for its own relative links. */
export function remarkWorkspaceFileLinks(options?: { baseDir?: string }) {
  const baseDir = options?.baseDir;
  return (tree: MdNode) => rewriteFileLinks(tree, baseDir);
}
