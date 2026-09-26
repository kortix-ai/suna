import { indexOfIgnoreCase, removeSpans, tagBlocks } from '@kortix/shared';

import type { UiTranslator } from '@/i18n/translator';
/**
 * Kortix System XML — utilities for handling <kortix_system> tags.
 *
 * Backend plugins wrap internal content (session context, memory, orchestrator
 * state, PTY output, etc.) in <kortix_system type="..." source="..."> tags.
 *
 * - stripKortixSystemTags: removes ALL tags before markdown rendering
 * - extractSessionReport: parses session-report tags into structured data
 *
 * Nothing here runs a regex over the message. The regexes these functions used
 * were quadratic or cubic in the text — extracting system messages from 60k
 * characters took 53 s — and every viewer of a session parses every user
 * message in it. The scanners are in `@kortix/shared/tag-blocks`.
 */

const OPEN = '<kortix_system';
const CLOSE = '</kortix_system>';

/** Removes every `<kortix_system …>…</kortix_system>` block, in any ASCII case. */
export function stripKortixSystemTags(text: string): string {
  if (!text) return '';
  return removeSpans(text, tagBlocks(text, 'kortix_system', { attributes: 'any', ignoreCase: true })).trim();
}

// ── Session Report extraction ────────────────────────────────────────────────

export interface SessionReport {
  sessionId: string;
  status: 'COMPLETE' | 'FAILED';
  project: string;
  prompt: string;
  result: string;
}

export function extractSessionReport(text: string): SessionReport | null {
  if (!text) return null;
  const xml = sessionReportXml(text);
  if (xml === null) return null;

  const get = (tag: string) => tagBlocks(xml, tag, { limit: 1 })[0]?.body.trim() || '';

  return {
    sessionId: get('session-id'),
    status: get('status') === 'FAILED' ? 'FAILED' : 'COMPLETE',
    project: get('project'),
    prompt: get('prompt'),
    result: get('result'),
  };
}

/**
 * The text between `<session-report>` and `</session-report>` after the first
 * `<kortix_system …>` tag that holds `type="session-report"`, with a closing
 * `</kortix_system>` after it — what
 * `/<kortix_system[^>]*type="session-report"[^>]*>[\s\S]*?<session-report>([\s\S]*?)<\/session-report>[\s\S]*?<\/kortix_system>/i`
 * captured. That regex was cubic: 7.6 s at 60k characters.
 */
function sessionReportXml(text: string): string | null {
  const marker = 'type="session-report"';
  let from = 0;
  // The first marker at or after the last position searched from; -2 until searched.
  let markerAt = -2;
  for (;;) {
    const open = indexOfIgnoreCase(text, OPEN, from);
    if (open === -1) return null;
    const attrs = open + OPEN.length;
    const gt = text.indexOf('>', attrs);
    if (gt === -1) return null;
    if (markerAt < attrs) markerAt = indexOfIgnoreCase(text, marker, attrs);
    if (markerAt === -1) return null;
    // The marker lies past this tag. Every opener before `gt` shares this tag's
    // attributes, so none of them holds the marker either.
    if (markerAt > gt) {
      from = gt;
      continue;
    }
    // Each search below failing means no later opener can succeed: its search starts later still.
    const start = indexOfIgnoreCase(text, '<session-report>', gt + 1);
    if (start === -1) return null;
    const stop = indexOfIgnoreCase(text, '</session-report>', start + 16);
    if (stop === -1) return null;
    if (indexOfIgnoreCase(text, CLOSE, stop + 17) === -1) return null;
    return text.slice(start + 16, stop);
  }
}

/**
 * Check if a user message text is purely a kortix_system message
 * (no visible user content outside the tags).
 */
export function isKortixSystemOnly(text: string): boolean {
  if (!text) return false;
  return stripKortixSystemTags(text).length === 0;
}

// ── System message parsing for inline rendering ─────────────────────────────

export interface KortixSystemMessage {
  type: string;
  source: string;
  label: string;
  detail?: string;
}

export interface KortixSystemElement {
  type: string;
  source: string;
  /** The text between the tags, untrimmed. */
  body: string;
}

/**
 * Each `<kortix_system …>…</kortix_system>` whose opening tag holds `type="…"`
 * and, after it, `source="…"` — what
 * `/<kortix_system[^>]*?\btype="([^"]*)"[^>]*?\bsource="([^"]*)"[^>]*>([\s\S]*?)<\/kortix_system>/gi`
 * matched, in order. That regex was cubic: 53 s at 60k characters.
 *
 * One intended difference: a `>` ends the opening tag even inside a quoted
 * value, as it does for `stripKortixSystemTags`. The regex read on through it.
 * The runtime never writes `>` into a type or a source.
 */
export function kortixSystemElements(text: string): KortixSystemElement[] {
  const out: KortixSystemElement[] = [];
  if (!text) return out;
  let from = 0;
  for (;;) {
    const open = indexOfIgnoreCase(text, OPEN, from);
    if (open === -1) return out;
    const attrs = open + OPEN.length;
    const gt = text.indexOf('>', attrs);
    if (gt === -1) return out;
    const found = typeAndSource(text.slice(attrs, gt));
    // Every opener before `gt` lies inside these attributes, so none of them has a match either.
    if (!found) {
      from = gt;
      continue;
    }
    const close = indexOfIgnoreCase(text, CLOSE, gt + 1);
    if (close === -1) return out;
    out.push({ ...found, body: text.slice(gt + 1, close) });
    from = close + CLOSE.length;
  }
}

/**
 * The value of the first `type="…"` in a tag's attributes and of the first
 * `source="…"` after that value. Both names match whole words in any ASCII case.
 * Only the first `type` counts: a later one has no `source` after it either.
 */
function typeAndSource(attrs: string): { type: string; source: string } | null {
  // Index 0 follows the tag name directly, so a word cannot start there.
  const type = attributeAt(attrs, 'type="', 1);
  if (type === -1) return null;
  const typeEnd = attrs.indexOf('"', type + 6);
  if (typeEnd === -1) return null;
  const source = attributeAt(attrs, 'source="', typeEnd + 1);
  if (source === -1) return null;
  const sourceEnd = attrs.indexOf('"', source + 8);
  if (sourceEnd === -1) return null;
  return { type: attrs.slice(type + 6, typeEnd), source: attrs.slice(source + 8, sourceEnd) };
}

/** The first `name` at or after `from` that starts a word, ignoring ASCII case; -1 when none does. */
function attributeAt(attrs: string, name: string, from: number): number {
  for (let at = indexOfIgnoreCase(attrs, name, from); at !== -1; at = indexOfIgnoreCase(attrs, name, at + 1)) {
    if (!/\w/.test(attrs[at - 1]!)) return at;
  }
  return -1;
}

/**
 * Extract structured info from kortix_system tags for inline UI rendering.
 * Returns an array of parsed system messages found in the text.
 */
export function extractKortixSystemMessages(
  text: string,
  tI18nComplete: UiTranslator,
): KortixSystemMessage[] {
  if (!text) return [];
  const results: KortixSystemMessage[] = [];
  for (const element of kortixSystemElements(text)) {
    const { type, source } = element;
    const body = element.body.trim();

    // Skip types that are already rendered elsewhere or are purely hidden context.
    if (
      type === 'session-report' ||
      type.startsWith('pty-') ||
      type === 'project-status' ||
      type === 'project-context' ||
      type === 'workspace-context' ||
      type === 'session-context' ||
      type === 'memory-context'
    )
      continue;

    const { label, detail } = describeSystemMessage(type, source, body, tI18nComplete);
    results.push({ type, source, label, detail });
  }
  return results;
}

function describeSystemMessage(
  type: string,
  source: string,
  body: string,
  tI18nComplete: UiTranslator,
): { label: string; detail?: string } {
  // Goal / Ralph continuation
  if (type === 'goal-continue' || type === 'ralph-continue') {
    const iterMatch = body.match(/\[(?:GOAL|RALPH)\s*-\s*ITERATION\s+(\d+)\/(\d+)\]/i);
    if (iterMatch) {
      return {
        label: tI18nComplete.raw('textcdbf6975e8a3'),
        detail: tI18nComplete('text3f63de86866c', {
          current: iterMatch[1],
          total: iterMatch[2],
        }),
      };
    }
    if (body.includes('COMPLETION REJECTED')) {
      return {
        label: tI18nComplete.raw('textcdbf6975e8a3'),
        detail: tI18nComplete.raw('textf6b6716f736b'),
      };
    }
    return {
      label: tI18nComplete.raw('textcdbf6975e8a3'),
      detail: tI18nComplete.raw('text6e9f041725ac'),
    };
  }

  // Task-related
  if (type === 'tasks') {
    return {
      label: tI18nComplete.raw('textb3a60e61a523'),
      detail: tI18nComplete.raw('text75c75efe327a'),
    };
  }

  // Project status injection
  if (type === 'project-status') {
    return { label: tI18nComplete.raw('text985959785319'), detail: 'status' };
  }

  // Rules / instructions
  if (type === 'rules' || type === 'instruction') {
    return { label: tI18nComplete.raw('text6725e7bbcd28'), detail: source.replace(/^kortix-/, '') };
  }

  // Fallback
  const shortSource = source.replace(/^kortix-/, '');
  return { label: type.replace(/-/g, ' '), detail: shortSource !== type ? shortSource : undefined };
}
