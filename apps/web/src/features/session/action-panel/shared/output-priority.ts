/**
 * The order a person cares about — not the order the machine made things in.
 *
 * A run that produces a report generates the report AND the dozen files it took
 * to build it. Chronological order buries the answer under the scaffolding:
 * someone asks for their profile as a PDF and the panel opens with `globals.css`,
 * `layout.tsx`, `Navbar.tsx`. Every one of those rows is truthful and none of
 * them is what the user came for.
 *
 * So documents lead, media follows, source code goes last. Nothing is hidden —
 * hiding would be a lie about what the agent did — but the thing they asked for
 * is the thing they see first, and the first row is always safe to click.
 */

import type { OutputItem } from './derive-panels';

/** Lower sorts first. */
const RANK_BY_EXT: Record<string, number> = {
  // The finished thing you send to someone.
  pdf: 0,
  // The numbers.
  xlsx: 1,
  xls: 1,
  csv: 2,
  tsv: 2,
  // The written document.
  docx: 3,
  doc: 3,
  // The deck.
  pptx: 4,
  ppt: 4,
  key: 4,
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic', 'bmp']);
const MEDIA_EXT = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'ogg']);

const RANK_IMAGE = 5;
const RANK_MEDIA = 6;
/** Everything else: source, config, styles — the making-of, not the thing. */
const RANK_OTHER = 7;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function outputRank(output: Pick<OutputItem, 'name' | 'kind'>): number {
  const ext = extensionOf(output.name);

  const byExt = RANK_BY_EXT[ext];
  if (byExt !== undefined) return byExt;

  if (IMAGE_EXT.has(ext) || output.kind === 'image') return RANK_IMAGE;
  if (MEDIA_EXT.has(ext) || output.kind === 'video') return RANK_MEDIA;
  // A generated deck may carry no filename at all — trust its kind.
  if (output.kind === 'presentation') return RANK_BY_EXT.pptx;

  return RANK_OTHER;
}

/** The kind a person recognizes — the row's right-hand whisper. Never an
 * extension, never a path (W3). */
export function deliverableKindLabel(output: Pick<OutputItem, 'name' | 'kind'>): string {
  if (output.kind === 'app') return 'Web app';
  if (output.kind === 'presentation') return 'Slides';
  if (output.kind === 'video') return 'Video';
  const ext = extensionOf(output.name);
  if (output.kind === 'image' || IMAGE_EXT.has(ext)) return 'Image';
  if (ext === 'pdf') return 'PDF';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || ext === 'tsv') return 'Spreadsheet';
  if (ext === 'docx' || ext === 'doc') return 'Document';
  if (ext === 'pptx' || ext === 'ppt' || ext === 'key') return 'Slides';
  if (MEDIA_EXT.has(ext)) return 'Video';
  return 'File';
}

/**
 * Sort by what the user came for. Stable: files of equal rank keep the order the
 * agent produced them in, so a run that wrote ten components still reads as the
 * sequence it happened in.
 */
export function sortOutputs(outputs: OutputItem[]): OutputItem[] {
  return outputs
    .map((output, index) => ({ output, index, rank: outputRank(output) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.output);
}

/**
 * THE deliverable — the one thing worth presenting unprompted when a run
 * finishes (W2). The run that just finished owns the payoff: a fresh
 * deliverable always beats a higher-ranked stale one, or finishing a quick
 * .docx would auto-open last week's report.pdf. Within each freshness group,
 * a live app beats every file (it's the thing the user asked for by name) and
 * files fall back to the same order the Outputs card shows. Stale-only input
 * still returns something — the chip-consume path may run after freshness
 * context is gone. Null when nothing is actually openable — auto-presenting a
 * dead row would open a detail that can't render anything.
 */
export function selectPrimaryDeliverable(
  apps: OutputItem[],
  files: OutputItem[],
): OutputItem | null {
  const pick = (as: OutputItem[], fs: OutputItem[]): OutputItem | null =>
    as.find((a) => a.url) ?? sortOutputs(fs).find((f) => f.path) ?? null;
  return (
    pick(apps.filter((a) => a.fresh), files.filter((f) => f.fresh)) ??
    pick(apps.filter((a) => !a.fresh), files.filter((f) => !f.fresh))
  );
}
