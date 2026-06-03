'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { UnifiedMarkdown } from './unified-markdown';

/**
 * Minimal YAML frontmatter rendering for markdown files (opencode-style agent
 * and skill definitions, but generic). The parser handles flat key/value pairs
 * plus a single level of nested objects — enough for the patterns documented
 * at https://opencode.ai/docs/agents/ and similar conventions.
 */

type FrontmatterValue = string | Record<string, string>;

export interface ParsedMarkdown {
  frontmatter: Record<string, FrontmatterValue> | null;
  body: string;
}

/** Extract a leading `---\n…\n---` frontmatter block. Returns the parsed
 *  object plus the markdown body. If no block is found, returns the original
 *  content untouched. */
function parseFrontmatter(content: string): ParsedMarkdown {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  const yaml = match[1];
  const body = match[2];

  const result: Record<string, FrontmatterValue> = {};
  let currentParent: string | null = null;

  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const nested = line.match(/^\s+([\w.-]+)\s*:\s*(.*)$/);
    if (nested && currentParent && typeof result[currentParent] === 'object') {
      (result[currentParent] as Record<string, string>)[nested[1]] = nested[2].trim();
      continue;
    }

    const top = line.match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (top) {
      const [, key, value] = top;
      const trimmed = value.trim();
      if (!trimmed) {
        result[key] = {};
        currentParent = key;
      } else {
        result[key] = trimmed;
        currentParent = null;
      }
    }
  }

  // Empty nested objects → render as blank string so they don't print "{}"
  for (const k of Object.keys(result)) {
    if (typeof result[k] === 'object' && Object.keys(result[k] as object).length === 0) {
      result[k] = '';
    }
  }

  return { frontmatter: result, body };
}

function ScalarValue({ value }: { value: string }) {
  // Strip surrounding quotes for display
  const v = value.replace(/^['"](.*)['"]$/, '$1');
  return <span className="text-foreground/90">{v || '—'}</span>;
}

function NestedTable({ data }: { data: Record<string, string> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <span className="text-muted-foreground/60">—</span>;
  return (
    <div className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {entries.map(([k, v]) => (
        <Badge key={k} size="sm" variant="secondary" className="gap-1">
          <span className="text-muted-foreground/70">{k}</span>
          <span className="text-muted-foreground/30">·</span>
          <ScalarValue value={v} />
        </Badge>
      ))}
    </div>
  );
}

/**
 * Render markdown content; if a leading YAML frontmatter block is present, it
 * renders as a small metadata card above the prose. Used for opencode-style
 * agent / skill markdown files (and any other frontmatter-prefixed `.md`).
 */
export function MarkdownWithFrontmatter({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const { frontmatter, body } = parseFrontmatter(content);
  return (
    <div className={className}>
      {frontmatter && <MarkdownFrontmatterCard data={frontmatter} />}
      <UnifiedMarkdown content={body} allowHtml={false} />
    </div>
  );
}

function MarkdownFrontmatterCard({
  data,
  className,
}: {
  data: Record<string, FrontmatterValue>;
  className?: string;
}) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;

  return (
    <div
      className={cn(
        'not-prose mb-6 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3',
        className,
      )}
    >
      <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs leading-relaxed font-mono">
        {entries.map(([key, value]) => (
          <React.Fragment key={key}>
            <span className="text-muted-foreground/70 select-none">{key}</span>
            <span className="min-w-0 break-words">
              {typeof value === 'string' ? (
                <ScalarValue value={value} />
              ) : (
                <NestedTable data={value} />
              )}
            </span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
