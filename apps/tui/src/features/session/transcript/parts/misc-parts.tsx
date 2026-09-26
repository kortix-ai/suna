/**
 * The classified parts that are one line each: attachments, delegations,
 * patches, retries, compactions, and the forward-compat `unknown` fallback.
 *
 * `step`, `snapshot` and `agent` never reach here — `isRenderablePart`
 * (lib/turn-layout.ts) drops them before the transcript builds rows.
 */

import type {
  ClassifiedCompactionPart,
  ClassifiedFilePart,
  ClassifiedPatchPart,
  ClassifiedRetryPart,
  ClassifiedSubtaskPart,
} from '@kortix/sdk';

import { clip } from '../../../../lib/turn-layout.ts';
import { theme } from '../../../../theme.ts';

export function FilePart({ part, width }: { part: ClassifiedFilePart; width: number }) {
  const kind = part.isImage ? 'image' : part.isPdf ? 'pdf' : part.mime;
  return <text fg={theme.dim}>{clip(`📎 ${part.filename ?? part.url} (${kind})`, width)}</text>;
}

export function SubtaskPart({ part, width }: { part: ClassifiedSubtaskPart; width: number }) {
  return (
    <text fg={theme.dim}>
      {clip(
        `→ delegated to ${part.agent}${part.description ? `: ${part.description}` : ''}`,
        width,
      )}
    </text>
  );
}

export function PatchPart({ part, width }: { part: ClassifiedPatchPart; width: number }) {
  const files = part.fileCount === 1 ? '1 file' : `${part.fileCount} files`;
  return <text fg={theme.dim}>{clip(`± ${files} changed (${part.hash.slice(0, 8)})`, width)}</text>;
}

export function RetryPart({ part, width }: { part: ClassifiedRetryPart; width: number }) {
  return <text fg={theme.danger}>{clip(`↻ retry ${part.attempt}: ${part.message}`, width)}</text>;
}

export function CompactionPart({ part, width }: { part: ClassifiedCompactionPart; width: number }) {
  const why = part.overflow ? 'context overflow' : part.auto ? 'auto' : 'manual';
  return <text fg={theme.faint}>{clip(`⋯ context compacted (${why})`, width)}</text>;
}

export function UnknownPart({ width }: { width: number }) {
  return <text fg={theme.faint}>{clip('· unrecognized part', width)}</text>;
}
