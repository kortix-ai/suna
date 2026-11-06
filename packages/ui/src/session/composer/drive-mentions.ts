import type { JSONContent } from '@tiptap/core';

/**
 * Drive `@` mentions in the composer's document. A Drive chip (`kind:
 * 'drive'`, `value` its Drive path) names a file; the bytes ride as an
 * ordinary attachment the composer staged when the file was picked.
 */

const isDriveChip = (node: JSONContent) => node.type === 'mention' && node.attrs?.kind === 'drive';

/** The Drive paths the document's chips name. */
export function drivePathsIn(doc: JSONContent | null | undefined): Set<string> {
  const paths = new Set<string>();
  const walk = (node: JSONContent) => {
    if (isDriveChip(node) && typeof node.attrs?.value === 'string') paths.add(node.attrs.value);
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return paths;
}

/** The document without the chips that name `path` (a file that could not be attached). */
export function withoutDriveChips(doc: JSONContent, path: string): JSONContent {
  const prune = (node: JSONContent): JSONContent =>
    node.content
      ? { ...node, content: node.content.filter((child) => !(isDriveChip(child) && child.attrs?.value === path)).map(prune) }
      : node;
  return prune(doc);
}

/** The staged uploads (Drive path → upload id) whose path no chip names any more: the tray drops them. */
export function orphanedDriveUploads(staged: ReadonlyMap<string, string>, doc: JSONContent | null | undefined): string[] {
  const named = drivePathsIn(doc);
  return [...staged].filter(([path]) => !named.has(path)).map(([path]) => path);
}
