/**
 * Consecutive `show` calls → one carousel.
 *
 * The agent often hands over related outputs as N separate `show` calls (two
 * screenshots of the same app, a page and its docs) instead of one `items`
 * call. Rendered one card per call, two screenshots fill a whole screen with
 * repeated chrome, and the outputs read as unrelated.
 *
 * `groupShowSegments` is a post-pass over `segmentTurn`: a run of standalone
 * `show` segments with nothing visible between them becomes one `show-group`
 * segment. `segmentTurn` already drops invisible parts, so two segments that
 * sit next to each other had nothing the reader could see between them. Any
 * text, burst, or other standalone tool breaks the run, which keeps narrative
 * order. A lone `show` stays `standalone` and renders exactly as before.
 *
 * `showGroupItems` flattens a group's calls into carousel items, one per
 * artifact, so N single calls and one N-item call render the same card.
 *
 * `Segment` itself is left unchanged: `show-group` exists only in this
 * function's output, so a host that never calls it never sees the new kind.
 */
import type { ToolPart } from '../../runtime/client';
import { isShowPayloadEmpty } from '../tools/show-availability';
import type { Segment, SegmentTurnOptions } from './segment-turn';
import { normalizeActivityToolName } from './session-activity-groups';

export interface ShowGroupSegment {
  kind: 'show-group';
  /** Two or more `show` / `show_user` calls, in call order. */
  parts: ToolPart[];
}

export type ShowGroupedSegment = Segment | ShowGroupSegment;

function isShowTool(toolName: string | undefined): boolean {
  const name = normalizeActivityToolName(toolName);
  return name === 'show' || name === 'show_user';
}

export function groupShowSegments(
  segments: ReadonlyArray<Segment>,
  opts: SegmentTurnOptions = {},
): ShowGroupedSegment[] {
  const out: ShowGroupedSegment[] = [];
  let run: Extract<Segment, { kind: 'standalone' }>[] = [];

  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) out.push({ kind: 'show-group', parts: run.map((s) => s.part) });
    run = [];
  };

  for (const segment of segments) {
    // A call waiting on a permission reply renders its own prompt, so it
    // never shares a card with another call.
    const groupable =
      segment.kind === 'standalone' &&
      isShowTool(segment.part.tool) &&
      !opts.standaloneCallIds?.has(segment.part.callID);
    if (groupable) {
      run.push(segment);
      continue;
    }
    flush();
    out.push(segment);
  }
  flush();
  return out;
}

/** One artifact in a show group. The payload fields match the `show` tool input. */
export interface ShowGroupItem {
  /** The call this item came from. A multi-item call contributes several. */
  callID: string;
  /**
   * `pending`: the call is still streaming its arguments.
   * `error`: the call failed; `error` carries the message.
   * `ready`: the payload is here and the item can render.
   */
  status: 'pending' | 'ready' | 'error';
  type: string;
  title?: string;
  description?: string;
  path?: string;
  url?: string;
  content?: string;
  language?: string;
  aspect_ratio?: string;
  /** Stored copy of `path` from saved history, so the item renders while the sandbox is off. */
  attachment?: string;
  error?: string;
}

const PAYLOAD_FIELDS = [
  'title',
  'description',
  'path',
  'url',
  'content',
  'language',
  'aspect_ratio',
  'attachment',
] as const;

function payloadItem(callID: string, raw: unknown): ShowGroupItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (isShowPayloadEmpty(source)) return null;
  const item: ShowGroupItem = {
    callID,
    status: 'ready',
    type: typeof source.type === 'string' ? source.type : '',
  };
  for (const field of PAYLOAD_FIELDS) {
    const value = source[field];
    if (typeof value === 'string' && value) item[field] = value;
  }
  return item;
}

/** `items` reaches the UI as an array or as a JSON string. */
function parseItems(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw.length > 0 ? raw : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function showGroupItems(parts: ReadonlyArray<ToolPart>): ShowGroupItem[] {
  const items: ShowGroupItem[] = [];
  for (const part of parts) {
    const state = part.state as {
      status?: string;
      input?: Record<string, unknown> | null;
      error?: unknown;
    };
    const input = state.input ?? {};

    if (state.status === 'error') {
      // A failed call keeps its slot: hiding it would read as "never ran".
      const title = typeof input.title === 'string' && input.title ? input.title : undefined;
      items.push({
        callID: part.callID,
        status: 'error',
        type: 'error',
        ...(title ? { title } : {}),
        error: typeof state.error === 'string' ? state.error : '',
      });
      continue;
    }

    const nested = parseItems(input.items);
    const ready = nested
      ? nested.map((raw) => payloadItem(part.callID, raw)).filter((i): i is ShowGroupItem => !!i)
      : [payloadItem(part.callID, input)].filter((i): i is ShowGroupItem => !!i);

    if (ready.length > 0) {
      items.push(...ready);
      continue;
    }

    // Nothing renderable yet. A live call gets a pending slot so the card
    // does not jump when its payload lands; a settled empty call is dropped.
    if (state.status === 'running' || state.status === 'pending') {
      items.push({ callID: part.callID, status: 'pending', type: '' });
    }
  }
  return items;
}
