import type { JSONContent } from '@tiptap/core';

import type { DriveUploadLike } from '../../internal/lib/project-preamble';
import type { AttachedFile } from './types';

/**
 * Drive `@` mentions in the composer. A Drive chip (`kind: 'drive'`, `value`
 * its Drive path) names a file; the bytes ride as an ordinary attachment the
 * composer staged when the file was picked, marked with the same path
 * (`AttachedFile.drivePath`).
 */

const isDriveChip = (node: JSONContent) => node.type === 'mention' && node.attrs?.kind === 'drive';

/** The document's Drive chips: Drive path → the file's name, first chip of a path wins. */
export function driveChipsIn(doc: JSONContent | null | undefined): Map<string, string> {
  const chips = new Map<string, string>();
  const walk = (node: JSONContent) => {
    const path = node.attrs?.value;
    if (isDriveChip(node) && typeof path === 'string' && path && !chips.has(path)) chips.set(path, String(node.attrs?.label ?? ''));
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return chips;
}

/** The Drive paths the document's chips name. */
export function drivePathsIn(doc: JSONContent | null | undefined): Set<string> {
  return new Set(driveChipsIn(doc).keys());
}

/** The document without the chips that name `path` (a file that could not be attached). */
export function withoutDriveChips(doc: JSONContent, path: string): JSONContent {
  const prune = (node: JSONContent): JSONContent =>
    node.content
      ? { ...node, content: node.content.filter((child) => !(isDriveChip(child) && child.attrs?.value === path)).map(prune) }
      : node;
  return prune(doc);
}

/**
 * The upload name for a picked Drive file: its own name, unless the tray
 * already holds that name, then the name with its folder (`logo (brand).png`),
 * so the agent tells two `logo.png` apart.
 */
export function driveUploadName(name: string, path: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const folder = path.split('/').slice(-2, -1)[0] || 'Drive';
  let candidate = `${stem} (${folder})${ext}`;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${stem} (${folder} ${n})${ext}`;
  return candidate;
}

/** The tray's files that came from Drive, as the reference blocks read them. */
export function driveUploadsOf(files: readonly AttachedFile[] | undefined): DriveUploadLike[] {
  return (files ?? []).flatMap((file) =>
    file.kind !== 'remote' && file.drivePath
      ? [{ name: file.kind === 'local' ? file.file.name : file.filename, drivePath: file.drivePath }]
      : [],
  );
}
