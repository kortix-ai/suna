/**
 * The session's own files, as `/` palette rows.
 *
 * The Easy panel already knows every file this session touched: the Outputs
 * card holds what the agent MADE, the Context card what it READ (both derived
 * in `action-panel/shared/derive-panels.ts`). Until now that knowledge stopped
 * at the panel — to hand one of those files back to the agent you had to
 * remember its path and retype it behind `@`, and the `@` menu could only find
 * it by searching the whole workspace index.
 *
 * This module is the bridge. It turns the panel's two file lists into one flat,
 * deduped `SlashFile[]` that `buildSlashSections` renders as the palette's
 * "Outputs" and "Context" sections, so picking a row inserts the same file
 * mention the `@` menu would — and the conversation continues with the file
 * attached.
 *
 * Pure and DOM-free on purpose: `composer.tsx` cannot be unit-tested in this
 * repo (no DOM harness), so the selection rules live here where they can be.
 */

import { toDaemonPath } from '@kortix/sdk';

import type { ContextItem, OutputItem } from '../../action-panel/shared/derive-panels';

/** Which card a file came from — decides the section it renders under. */
export type SlashFileOrigin = 'output' | 'context';

export interface SlashFile {
  /**
   * Workspace-relative path. This is BOTH the mention's label and its value,
   * because only `label` survives serialization for a file mention
   * (`editor/serialize.ts`'s `collectMentions` — files are addressed by label,
   * sessions are the only kind that round-trips an id). Put a basename here
   * and the agent receives a `<file_ref>` it cannot resolve.
   */
  path: string;
  /** What the row shows — the output's human title when it has one, else the
   *  basename. Never the full path: that is the row's trailing folder text and
   *  the detail pane's description. */
  name: string;
  /** The folder the file sits in, `''` at the workspace root. Shown muted at
   *  the end of the row so two `index.ts` rows are told apart without opening
   *  the detail pane. */
  folder: string;
  origin: SlashFileOrigin;
}

/** Last path segment, tolerant of `\` — same rule as `derive-panels.ts`. */
function basename(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Everything before the last segment — `''` for a file at the root. */
function folderOf(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx > 0 ? cleaned.slice(0, idx) : '';
}

/**
 * Normalized to the SAME shape `derive-panels.ts` dedupes with
 * (`outputPathKey`) — workspace-relative, forward slashes, no `./` — so an
 * absolute write (`/workspace/report.md`) and a relative read (`report.md`)
 * of one file can never become two rows here either. `toDaemonPath` is what
 * `toWorkspaceRelative` now aliases (the SDK deprecated the old name), and it
 * is also the path shape `searchWorkspaceFiles` hands the `@` menu — so one
 * file produces one identical mention from either palette.
 */
function normalizePath(path: string): string {
  return toDaemonPath(path.replace(/\\/g, '/').replace(/^\.\//, ''));
}

/**
 * Every file this session has on offer, Outputs first, deduped by path.
 *
 * Order is inherited, not invented: `panel.files` arrives already ranked by
 * `sortOutputs` (deliverables before scaffolding, this run's before older
 * ones), and re-sorting here would put the palette and the Outputs card in
 * disagreement about which file matters most.
 *
 * Outputs win a tie. A file the agent wrote AND read is a deliverable that
 * happened to be re-read, not context — and it must appear exactly once, or
 * one file offers two rows that insert the identical mention.
 *
 * Apps are skipped. An `app` output is a URL on a port, not a path on disk
 * (`derive-panels.ts`'s `AppOutputItem`), so there is no file to reference.
 */
export function sessionSlashFiles(input: {
  outputs: readonly OutputItem[];
  contextFiles: readonly ContextItem[];
}): SlashFile[] {
  const seen = new Set<string>();
  const files: SlashFile[] = [];

  const push = (rawPath: string, label: string, origin: SlashFileOrigin) => {
    const path = normalizePath(rawPath);
    if (!path || seen.has(path)) return;
    seen.add(path);
    files.push({ path, name: label || basename(path), folder: folderOf(path), origin });
  };

  for (const output of input.outputs) {
    if (output.kind === 'app' || !output.path) continue;
    // `title ?? name` — the display rule `OutputItemBase.title` documents, so
    // the palette calls a deliverable what the Outputs card calls it.
    push(output.path, output.title ?? output.name, 'output');
  }
  for (const item of input.contextFiles) {
    if (!item.path) continue;
    push(item.path, item.label, 'context');
  }

  return files;
}

/**
 * Query filter for file rows.
 *
 * Matches the PATH, not just the displayed name: `/docs` has to find
 * `docs/report.md` even though the row reads "report.md". The name is matched
 * too because an output's `title` ("Q3 revenue report") is often nothing like
 * its filename.
 */
export function filterSlashFiles(files: readonly SlashFile[], query: string): SlashFile[] {
  const q = query.toLowerCase().trim();
  if (!q) return [...files];
  return files.filter(
    (f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
  );
}
