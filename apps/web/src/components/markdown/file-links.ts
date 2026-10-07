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

/** The workspace path a link points at, or `null` for any other link. */
export function workspaceFileLinkPath(url: string | undefined): string | null {
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
  return path || null;
}

export function parseFileLinkHref(href: string | undefined): string | null {
  if (!href?.startsWith(FILE_LINK_HREF)) return null;
  try {
    return decodeURIComponent(href.slice(FILE_LINK_HREF.length)) || null;
  } catch {
    return null;
  }
}

function rewriteFileLinks(node: MdNode): void {
  if (node.type === 'link' || node.type === 'definition') {
    const path = workspaceFileLinkPath(node.url);
    if (path) node.url = `${FILE_LINK_HREF}${encodeURIComponent(path)}`;
  }
  node.children?.forEach(rewriteFileLinks);
}

export function remarkWorkspaceFileLinks() {
  return (tree: MdNode) => rewriteFileLinks(tree);
}
