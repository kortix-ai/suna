'use client';

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { SystemMessage } from '@/components/ui/system-message';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';

// ============================================================================
// Parse <file> XML references from uploaded file text parts
// ============================================================================

interface ParsedFileRef {
  path: string;
  mime: string;
  filename: string;
  /** Present only on an optimistic ref, whose bytes have not landed yet: a
   *  stable per-attachment id standing in for the absent server path. See
   *  `uploaded-file-refs.ts`. */
  pending?: string;
}

// Attributes are read by NAME, not by position, so an optional `pending` can be
// appended without the tag becoming unparseable. A value can never contain a
// raw `>` — `xmlAttr` escapes it — so `[^>]*` cannot run past the tag.
const FILE_TAG_REGEX = /<file\s+([^>]*?)>\s*[\s\S]*?<\/file>/g;

export function parseFileReferences(text: string): {
  cleanText: string;
  files: ParsedFileRef[];
} {
  const files: ParsedFileRef[] = [];
  const cleanText = text
    .replace(FILE_TAG_REGEX, (whole, attrs: string) => {
      const pick = (key: string): string | undefined => {
        const m = attrs.match(new RegExp(`\\b${key}="([^"]*?)"`));
        // Every attribute is unescaped on the way out. `xmlAttr` escapes `&`,
        // `"`, `<` and `>` on the way in, and this side used to push the RAW
        // attribute back — so `R&D report.pdf` reached the transcript, and the
        // model, as the literal `R&amp;D report.pdf`.
        return m ? unescapeAttr(m[1]) : undefined;
      };
      const path = pick('path');
      const filename = pick('filename');
      // A tag carrying neither is not a file reference; leave it in the text
      // rather than silently swallowing it.
      if (path === undefined && filename === undefined) return whole;
      const pending = pick('pending');
      files.push({
        path: path ?? '',
        mime: pick('mime') ?? '',
        filename: filename ?? '',
        ...(pending ? { pending } : {}),
      });
      return '';
    })
    .trim();
  return { cleanText, files };
}

// ============================================================================
// Parse <session_ref> XML tags from session mention text parts
// ============================================================================

interface ParsedSessionRef {
  id: string;
  title: string;
}

export function parseSessionReferences(text: string): {
  cleanText: string;
  sessions: ParsedSessionRef[];
} {
  const sessions: ParsedSessionRef[] = [];
  let cleaned = text.replace(
    /<session_ref\s+id="([^"]*?)"\s+title="([^"]*?)"\s*\/>/g,
    (_, id, title) => {
      sessions.push({ id, title });
      return '';
    },
  );
  // Strip the instruction header text
  cleaned = cleaned
    .replace(
      /\n*Referenced sessions \(use the session_context tool to fetch details when needed\):\n?/g,
      '',
    )
    .trim();
  return { cleanText: cleaned, sessions };
}

// ============================================================================
// Parse <project_ref> XML references from project mentions / selector
// ============================================================================

export interface ParsedProjectRef {
  id?: string;
  name: string;
  path?: string;
  description?: string;
}

/**
 * The exact inverse of `xmlAttr` in `uploaded-file-refs.ts`.
 *
 * `&amp;` is undone LAST, so an escaped `&lt;` (written `&amp;lt;`) comes back
 * as the literal `&lt;` rather than being unescaped twice into `<`.
 */
function unescapeAttr(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function parseProjectReferences(text: string): {
  cleanText: string;
  projects: ParsedProjectRef[];
} {
  // Historical messages may contain <project_ref/> blocks. Projects are no
  // longer a user-facing/runtime concept, so strip the metadata without
  // rendering project chips or passing project refs forward.
  let cleaned = text.replace(/<project_ref\b([\s\S]*?)\/>/g, '');
  // Strip the instruction header (description uses [^)]* which is safe
  // because the header never contains a literal `)` before its closing one).
  cleaned = cleaned.replace(/\n*Referenced projects \([^)]*\):\n?/g, '').trim();
  return { cleanText: cleaned, projects: [] };
}

// ============================================================================
// Parse <file_ref> + <agent_ref> XML tags from @ mentions in chat input
// ============================================================================
//
// Uploaded files still use the existing <file path="..." mime="..." ...>
// tag (parseFileReferences). These new tags only cover @-mention-style refs
// to existing workspace files and agents, so the agent sees structured
// metadata and the renderer strips them out of the visible text.

export interface ParsedFileMentionRef {
  path: string;
  name: string;
}
export interface ParsedAgentMentionRef {
  name: string;
}

export function parseFileMentionReferences(text: string): {
  cleanText: string;
  files: ParsedFileMentionRef[];
} {
  const files: ParsedFileMentionRef[] = [];
  let cleaned = text.replace(/<file_ref\b([\s\S]*?)\/>/g, (_, attrs: string) => {
    const pick = (key: string): string | undefined => {
      const m = attrs.match(new RegExp(`${key}="([^"]*?)"`));
      return m ? unescapeAttr(m[1]) : undefined;
    };
    const path = pick('path');
    const name = pick('name') ?? path;
    if (path) files.push({ path, name: name || path });
    return '';
  });
  cleaned = cleaned.replace(/\n*Referenced files \([^)]*\):\n?/g, '').trim();
  return { cleanText: cleaned, files };
}

export function parseAgentMentionReferences(text: string): {
  cleanText: string;
  agents: ParsedAgentMentionRef[];
} {
  const agents: ParsedAgentMentionRef[] = [];
  let cleaned = text.replace(/<agent_ref\b([\s\S]*?)\/>/g, (_, attrs: string) => {
    const pick = (key: string): string | undefined => {
      const m = attrs.match(new RegExp(`${key}="([^"]*?)"`));
      return m ? unescapeAttr(m[1]) : undefined;
    };
    const name = pick('name');
    if (name) agents.push({ name });
    return '';
  });
  cleaned = cleaned.replace(/\n*Referenced agents \([^)]*\):\n?/g, '').trim();
  return { cleanText: cleaned, agents };
}

// ============================================================================
// Parse <reply_context> XML from select-and-reply feature
// ============================================================================

export function parseReplyContext(text: string): {
  cleanText: string;
  replyContext: string | null;
} {
  const match = text.match(/<reply_context>([\s\S]*?)<\/reply_context>/);
  if (!match) return { cleanText: text, replyContext: null };
  const replyContext = match[1].trim();
  const cleanText = text.replace(/<reply_context>[\s\S]*?<\/reply_context>\s*/, '').trim();
  return { cleanText, replyContext };
}

// ── Generic XML notification parsing ──────────────────────────────────
//
// Matches any XML block: <tag_name>...content...</tag_name>
// No hardcoded tag names. Runs LAST in the parsing pipeline so all
// other XML subsystems (file refs, session refs, reply context, DCP,
// kortix_system) have already consumed their tags. Whatever remains
// is a system notification.
const XML_BLOCK_REGEX = /<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/gi;

interface SystemNotification {
  tag: string;
  label: string;
  fields: [string, string][];
  body: string;
}

/** Parse all remaining XML blocks from text as system notifications. */
export function parseSystemNotifications(text: string): {
  cleanText: string;
  notifications: SystemNotification[];
} {
  const notifications: SystemNotification[] = [];
  const cleanText = text
    .replace(XML_BLOCK_REGEX, (_full, tag: string, rawBody: string) => {
      const fields: [string, string][] = [];
      const bodyLines: string[] = [];
      let pastHeader = false;

      for (const line of rawBody.trim().split('\n')) {
        if (pastHeader) {
          bodyLines.push(line);
          continue;
        }
        if (line.trim() === '') {
          pastHeader = true;
          continue;
        }
        const m = line.match(/^([A-Za-z][\w\s]*?):\s*(.+)$/);
        if (m) {
          fields.push([m[1].trim(), m[2].trim()]);
        } else {
          pastHeader = true;
          bodyLines.push(line);
        }
      }

      notifications.push({
        tag: tag.toLowerCase(),
        label: tag.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
        fields,
        body: bodyLines.join('\n').trim(),
      });
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanText, notifications };
}

export function stripSystemPtyText(text: string): string {
  if (!text) return '';
  // Only strip kortix_system tags (backend-internal metadata).
  // Notification XML is stripped later by parseSystemNotifications()
  // which runs last in the parsing pipeline.
  return stripKortixSystemTags(text)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The session could not continue, or something was lost. Red is spent here and
 * nowhere else — a recovered retry is not an error, and if routine failures go
 * red then red stops meaning anything by the time it matters.
 */
const CRITICAL =
  /\b(aborted|corrupted?|crashed|denied|error|errored|exceeded|exhausted|expired|failed|failure|fatal|forbidden|lost|missing|rejected|revoked|timed out|timeout|unauthorized|unavailable|unreachable)\b/;

/** Still running but degraded, or stopped and waiting on the person reading it. */
const NEEDS_ATTENTION =
  /\b(blocked|blocker|degraded|deprecated|limit|limited|needs|partial|paused|requires|retried|retry|retrying|skipped|stopped|throttled|waiting)\b/;

/**
 * Which tone a notification tag earns.
 *
 * The parser accepts any XML block the other subsystems did not claim, so there
 * is no fixed vocabulary to map — the tag is the only signal the emitter gives
 * us. Keywords match on word boundaries against the spaced-out tag
 * ("quota_exceeded" -> "quota exceeded"), so "exceeded" hits and "proceeded"
 * does not. Anything unrecognised stays neutral on purpose: a tag nobody
 * classified should read as quiet, never as alarming.
 */
export function systemNotificationSeverity(tag: string): 'error' | 'warning' | 'action' {
  const words = tag.replace(/[-_]/g, ' ');
  if (CRITICAL.test(words)) return 'error';
  if (NEEDS_ATTENTION.test(words)) return 'warning';
  return 'action';
}

/**
 * One quiet line in the chat stream telling the reader what the session just
 * did. Deliberately not an inspector: no expander, no field table, no stack
 * trace. Tone carries the severity, the sentence carries the rest.
 */
export function SystemNotificationCard({ notification }: { notification: SystemNotification }) {
  // One detail, and the friendliest one: identifiers and codes ("daytona",
  // "1.2s", "us-east-1") have no spaces, so the longest value that does is the
  // closest thing to a sentence the tag gave us. Overflow is a truncated line,
  // never a second row.
  let detail: string | undefined;
  for (const [, value] of notification.fields) {
    if (value.includes(' ') && (!detail || value.length > detail.length)) {
      detail = value;
    }
  }

  return (
    <Disclosure variant="outline" className="bg-secondary">
      <DisclosureTrigger>
        <SystemMessage variant={systemNotificationSeverity(notification.tag)} fill>
          <span className="block truncate">
            {notification.label}
            {detail && <span className="ml-1.5 opacity-70">{detail}</span>}
          </span>
        </SystemMessage>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="space-y-1 px-3 pb-2 text-xs">
          {notification.fields.length > 0 && (
            <div className="space-y-0.5">
              {notification.fields.map(([key, value]) => (
                <div key={`${key}:${value}`} className="flex min-w-0 gap-2">
                  <span className="text-muted-foreground shrink-0">{key}:</span>
                  <span className="text-foreground font-mono text-xs break-all">{value}</span>
                </div>
              ))}
            </div>
          )}
          {notification.body && (
            <div className="text-muted-foreground/50 max-h-48 overflow-y-auto font-mono text-xs break-all whitespace-pre-wrap">
              {notification.body.slice(0, 2000)}
            </div>
          )}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
