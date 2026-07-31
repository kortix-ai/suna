'use client';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { STATUS_TEXT } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { CaretRightIcon as ChevronRight, TerminalWindowIcon as Terminal } from '@phosphor-icons/react';
import { useState } from 'react';

// ============================================================================
// Parse <file> XML references from uploaded file text parts
// ============================================================================

interface ParsedFileRef {
  path: string;
  mime: string;
  filename: string;
}

const FILE_TAG_REGEX =
  /<file\s+path="([^"]*?)"\s+mime="([^"]*?)"\s+filename="([^"]*?)">\s*[\s\S]*?<\/file>/g;

export function parseFileReferences(text: string): {
  cleanText: string;
  files: ParsedFileRef[];
} {
  const files: ParsedFileRef[] = [];
  const cleanText = text
    .replace(FILE_TAG_REGEX, (_, path, mime, filename) => {
      files.push({ path, mime, filename });
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

function unescapeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
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
        label: tag.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
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

export function SystemNotificationCard({ notification }: { notification: SystemNotification }) {
  const [open, setOpen] = useState(false);

  // Show first 1-2 short field values inline as muted detail
  const inlineDetail = notification.fields
    .slice(0, 2)
    .map(([, v]) => v)
    .filter((v) => v.length < 40)
    .join(' · ');

  // Expandable when there's a body, >2 fields, or any long values
  const hasExpandable =
    !!notification.body ||
    notification.fields.length > 2 ||
    notification.fields.some(([, v]) => v.length >= 40);

  const isError = notification.tag.includes('failed') || notification.tag.includes('blocker');
  const isWarning = notification.tag.includes('stopped');

  const iconColor = isError
    ? 'text-destructive/50'
    : isWarning
      ? STATUS_TEXT.warning
      : 'text-muted-foreground/50';

  const trigger = (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-2xl px-2.5 py-1.5',
        'bg-muted/20 border-border/40 border',
        'max-w-full text-xs select-none',
        hasExpandable && 'hover:bg-muted/40 cursor-pointer transition-colors',
      )}
    >
      <Terminal className={cn('size-3.5 flex-shrink-0', iconColor)} />
      <span className="text-muted-foreground/70 truncate">
        {notification.label}
        {inlineDetail && (
          <span className="text-muted-foreground/40 ml-1.5 font-mono">{inlineDetail}</span>
        )}
      </span>
      {hasExpandable && (
        <ChevronRight
          className={cn(
            'text-muted-foreground/30 ml-auto size-3 flex-shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
      )}
    </div>
  );

  if (!hasExpandable) return trigger;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>{trigger}</CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/40 bg-muted/10 space-y-1 rounded-b-lg border border-t-0 px-3 py-2 text-xs">
          {notification.fields.length > 0 && (
            <div className="space-y-0.5">
              {notification.fields.map(([key, value], i) => (
                <div key={i} className="flex min-w-0 gap-2">
                  <span className="text-muted-foreground/40 flex-shrink-0">{key}:</span>
                  <span className="text-muted-foreground/60 font-mono text-xs break-all">
                    {value}
                  </span>
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
      </CollapsibleContent>
    </Collapsible>
  );
}
