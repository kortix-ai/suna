import type { UiTranslator } from '@/i18n/translator';
/**
 * Kortix System XML — utilities for handling <kortix_system> tags.
 *
 * Backend plugins wrap internal content (session context, memory, orchestrator
 * state, PTY output, etc.) in <kortix_system type="..." source="..."> tags.
 *
 * - stripKortixSystemTags: removes ALL tags before markdown rendering
 * - extractSessionReport: parses session-report tags into structured data
 */

const KORTIX_SYSTEM_RE = /<kortix_system[^>]*>[\s\S]*?<\/kortix_system>/gi;

export function stripKortixSystemTags(text: string): string {
  if (!text) return '';
  return text.replace(KORTIX_SYSTEM_RE, '').trim();
}

// ── Session Report extraction ────────────────────────────────────────────────

export interface SessionReport {
  sessionId: string;
  status: 'COMPLETE' | 'FAILED';
  project: string;
  prompt: string;
  result: string;
}

const SESSION_REPORT_RE =
  /<kortix_system[^>]*type="session-report"[^>]*>[\s\S]*?<session-report>([\s\S]*?)<\/session-report>[\s\S]*?<\/kortix_system>/i;

export function extractSessionReport(text: string): SessionReport | null {
  if (!text) return null;
  const match = text.match(SESSION_REPORT_RE);
  if (!match) return null;

  const xml = match[1];
  const get = (tag: string) => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m?.[1]?.trim() || '';
  };

  return {
    sessionId: get('session-id'),
    status: get('status') === 'FAILED' ? 'FAILED' : 'COMPLETE',
    project: get('project'),
    prompt: get('prompt'),
    result: get('result'),
  };
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

const KORTIX_SYSTEM_EXTRACT_RE =
  /<kortix_system[^>]*?\btype="([^"]*)"[^>]*?\bsource="([^"]*)"[^>]*>([\s\S]*?)<\/kortix_system>/gi;

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
  let match: RegExpExecArray | null;
  const re = new RegExp(KORTIX_SYSTEM_EXTRACT_RE.source, 'gi');
  while ((match = re.exec(text)) !== null) {
    const type = match[1];
    const source = match[2];
    const body = match[3].trim();

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
