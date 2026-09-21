/**
 * Pure rules behind the activity sheet — the timeline a burst's summary row
 * opens on mobile (`components/session/turn/activity-sheet.tsx`).
 *
 * One entry per thing the agent did: a thought (merged fragments), or one tool
 * call. Same-family group rows are unfolded, so every call is its own entry
 * with its own detail view. Grouping, plumbing, and the thought-running rule
 * come from `burstView` (and through it `mergeBurstSteps`), so the sheet lists
 * exactly the steps the summary row counts.
 *
 * No React, no React Native.
 */

import {
  isToolPart,
  narrationToolName,
  normalizeActivityToolName,
  partOutcome,
  stepLabel,
  type Part,
} from '@kortix/sdk';
import { activityIconKey, type ActivityIconKey, type BurstView } from './activity';

export type ActivitySheetEntry =
  | {
      kind: 'thought';
      key: string;
      /** One line: the thought's bold heading, else its first sentence. */
      title: string;
      /** The thought as markdown, without the heading the title took. */
      body: string;
      running: boolean;
      openable: true;
    }
  | {
      kind: 'tool';
      key: string;
      part: Part;
      /** SDK step label: "Read a.ts", "Running bun test". */
      title: string;
      icon: ActivityIconKey;
      running: boolean;
      failed: boolean;
      /** The call has a body to show (`toolHasDetail`). */
      openable: boolean;
    };

// ─── Thought ─────────────────────────────────────────────────────────────────

const LEADING_HEADING = /^\s*\*\*([^*\n]+)\*\*\s*/;
const FIRST_SENTENCE = /^(.+?[.!?])(?:\s|$)/;

/** Markdown that carries no meaning in a one-line title. */
function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A thought's title and body. Reasoning models often open a thought with a
 * bold heading: that heading is the title, and the body drops it. Otherwise
 * the title is the first sentence of the plain text.
 */
export function summarizeThought(texts: ReadonlyArray<string>): { title: string; body: string } {
  const headed = texts.findIndex((text) => LEADING_HEADING.test(text));
  if (headed >= 0) {
    const title = LEADING_HEADING.exec(texts[headed])![1].trim();
    const body = texts
      .map((text, index) => (index === headed ? text.replace(LEADING_HEADING, '') : text).trim())
      .filter(Boolean)
      .join('\n\n');
    return { title, body };
  }
  const plain = plainText(texts.join(' '));
  return { title: FIRST_SENTENCE.exec(plain)?.[1] ?? (plain || 'Thinking'), body: texts.join('\n\n') };
}

// ─── Tool ────────────────────────────────────────────────────────────────────

/** Rows that navigate or render nothing instead of showing a body. */
const NO_DETAIL_TOOLS: ReadonlySet<string> = new Set(['project_select', 'project_create', 'todoread']);

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

/** The call has something to show in a detail view: arguments, output, an error, or live progress. */
export function toolHasDetail(part: Part): boolean {
  if (!isToolPart(part)) return false;
  if (NO_DETAIL_TOOLS.has(normalizeActivityToolName(part.tool).replace(/^oc[-_]/, '').replace(/-/g, '_'))) return false;
  const state = part.state as { status: string; input?: Record<string, unknown>; output?: string; error?: string };
  if (state.status === 'pending' || state.status === 'running') return true;
  if (state.status === 'error') return true;
  if (hasValue(state.output)) return true;
  return Object.values(state.input ?? {}).some(hasValue);
}

function toolRunning(part: Part, burstRunning: boolean): boolean {
  if (!burstRunning || !isToolPart(part)) return false;
  const status = part.state.status;
  return status === 'pending' || status === 'running';
}

function toolTitle(part: Part, running: boolean): string {
  const label = stepLabel(part);
  const verb = running ? label.running : label.verb;
  // An unregistered tool's object is its raw identifier; name it in words.
  const object = label.verb === 'Used' && isToolPart(part) ? narrationToolName(part.tool) : label.object;
  return object ? `${verb} ${object}` : verb;
}

function toolEntry(part: Part, burstRunning: boolean): ActivitySheetEntry {
  const running = toolRunning(part, burstRunning);
  return {
    kind: 'tool',
    key: part.id,
    part,
    title: toolTitle(part, running),
    icon: activityIconKey(part),
    running,
    failed: isToolPart(part) && !running && partOutcome(part) !== 'ok',
    openable: toolHasDetail(part),
  };
}

export function activitySheetEntries(view: Pick<BurstView, 'steps' | 'running'>): ActivitySheetEntry[] {
  return view.steps.flatMap<ActivitySheetEntry>((step) => {
    if (step.kind === 'thought') {
      return [
        {
          kind: 'thought',
          key: step.key,
          ...summarizeThought(step.texts),
          running: view.running && step.running,
          openable: true,
        },
      ];
    }
    if (step.kind === 'group') return step.step.parts.map((part) => toolEntry(part as Part, view.running));
    return [toolEntry(step.part, view.running)];
  });
}

// ─── Ownership ───────────────────────────────────────────────────────────────

/**
 * A burst row still owns the open sheet when it shares any part with it. A
 * burst re-keys when its first part leaves (a call split out for a permission
 * prompt), so part identity, not the row, decides.
 */
export function ownsBurst(openPartIds: ReadonlyArray<string>, parts: ReadonlyArray<Pick<Part, 'id'>>): boolean {
  return parts.some((part) => openPartIds.includes(part.id));
}

/** A permission prompt waits on a call the sheet showed: the sheet must get out of its way. */
export function burstHasPendingPermission(
  callIds: ReadonlyArray<string>,
  permissions: ReadonlyArray<{ tool?: { callID: string } }>,
): boolean {
  return permissions.some((permission) => Boolean(permission.tool && callIds.includes(permission.tool.callID)));
}
