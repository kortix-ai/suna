/**
 * The three range outputs, read defensively. A pipeline writes model output
 * (`CaptureRangeOutput.output` is `Record<string, unknown>` in the SDK), so a
 * missing or mistyped field drops that item instead of breaking the page.
 */
import type { CaptureRangeDetail, CaptureRangeOutput } from '@kortix/sdk';

export interface RangeStep {
  /** Seconds after the range start. */
  startSec: number;
  endSec: number | null;
  title: string;
  app: string | null;
  detail: string | null;
  idle: boolean;
}

export interface RangeTranscriptSection {
  startSec: number;
  heading: string;
  narrative: string;
}

export interface RangeSummary {
  title: string | null;
  summary: string | null;
  entities: string[];
}

export type OutputState = 'missing' | 'running' | 'failed' | 'done';

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];

export function outputOf(range: CaptureRangeDetail | undefined, kind: CaptureRangeOutput['kind']) {
  return range?.outputs.find((output) => output.kind === kind) ?? null;
}

export function outputState(output: CaptureRangeOutput | null): OutputState {
  if (!output) return 'missing';
  if (output.status === 'running') return 'running';
  if (output.status === 'failed') return 'failed';
  return 'done';
}

/** Steps from the segmentation output: one per segment, idle segments marked. */
export function rangeSteps(output: CaptureRangeOutput | null): RangeStep[] {
  return list(output?.output?.segments)
    .map((segment) => ({
      startSec: num(segment.startSec) ?? 0,
      endSec: num(segment.endSec),
      title: str(segment.title) ?? str(segment.heading) ?? '',
      app: str(segment.app),
      detail: str(segment.annotation) ?? str(segment.description),
      idle: segment.idle === true || segment.category === 'idle',
    }))
    .filter((step) => step.title)
    .sort((a, b) => a.startSec - b.startSec);
}

/** Transcript sections: heading and narrative per segment. */
export function rangeTranscript(output: CaptureRangeOutput | null): RangeTranscriptSection[] {
  return list(output?.output?.segments)
    .map((segment) => ({
      startSec: num(segment.startSec) ?? 0,
      heading: str(segment.heading) ?? str(segment.title) ?? '',
      narrative: str(segment.narrative) ?? str(segment.summary) ?? '',
    }))
    .filter((section) => section.heading || section.narrative)
    .sort((a, b) => a.startSec - b.startSec);
}

/** The annotation's title, summary and entities; the transcript's summary when no annotation. */
export function rangeSummary(
  annotation: CaptureRangeOutput | null,
  transcript: CaptureRangeOutput | null,
): RangeSummary {
  const a = annotation?.output ?? {};
  const t = transcript?.output ?? {};
  return {
    title: str(a.title) ?? str(t.title),
    summary: str(a.summary) ?? str(t.summary),
    entities: (Array.isArray(a.entities) ? a.entities : [])
      .map(str)
      .filter((e): e is string => !!e),
  };
}
