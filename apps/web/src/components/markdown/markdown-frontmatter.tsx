'use client';

import { Badge } from '@/components/ui/badge';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { cn } from '@/lib/utils';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { UnifiedMarkdown } from './unified-markdown';

/**
 * Minimal YAML frontmatter rendering for markdown files (opencode-style agent
 * and skill definitions, but generic). The parser handles flat key/value pairs
 * plus a single level of nested objects — enough for the patterns documented
 * at https://opencode.ai/docs/agents/ and similar conventions.
 */

export type FrontmatterValue = string | Record<string, string>;

export interface ParsedMarkdown {
  frontmatter: Record<string, FrontmatterValue> | null;
  body: string;
}

/** Extract a leading `---\n…\n---` frontmatter block. Returns the parsed
 *  object plus the markdown body. If no block is found, returns the original
 *  content untouched. */
export function parseFrontmatter(content: string): ParsedMarkdown {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  const yaml = match[1];
  const body = match[2];

  const result: Record<string, FrontmatterValue> = {};
  let currentParent: string | null = null;

  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // A nested key may be QUOTED, and in the opencode permission idiom it
    // usually is — `"*": allow`. Matching only [\w.-] dropped that line, left
    // the parent an empty object, and printed a bare em-dash where the
    // permissions belong. Wildcards and path-ish keys are accepted bare too.
    const nested = line.match(/^\s+(?:"([^"]+)"|'([^']+)'|([\w.*/-]+))\s*:\s*(.*)$/);
    if (nested && currentParent && typeof result[currentParent] === 'object') {
      const key = nested[1] ?? nested[2] ?? nested[3];
      (result[currentParent] as Record<string, string>)[key] = nested[4].trim();
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

const VALUE_COLLAPSED_MAX_H = 'max-h-24';

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
          <span className="text-muted-foreground/30">&bull;</span>
          <ScalarValue value={v} />
        </Badge>
      ))}
    </div>
  );
}

/**
 * Value cell: capped at `VALUE_COLLAPSED_MAX_H` + fade while collapsed,
 * with Show more / Show less once the content overflows the cap.
 */
function FrontmatterValueBody({ value }: { value: FrontmatterValue }) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const body =
    typeof value === 'string' ? <ScalarValue value={value} /> : <NestedTable data={value} />;

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el || expanded) return;
    setCanExpand(el.scrollHeight > el.clientHeight + 1);
  }, [expanded]);

  useLayoutEffect(() => {
    checkOverflow();
  }, [checkOverflow, value]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    window.addEventListener('resize', checkOverflow);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', checkOverflow);
    };
  }, [checkOverflow, value, expanded]);

  return (
    <div className="min-w-0">
      {expanded ? (
        <div className="break-words">{body}</div>
      ) : (
        <FadedScrollArea
          ref={scrollRef}
          fadeColor="from-sidebar"
          rootClassName={cn('h-auto min-w-0', VALUE_COLLAPSED_MAX_H)}
          className={cn('break-words', VALUE_COLLAPSED_MAX_H)}
        >
          {body}
        </FadedScrollArea>
      )}
      {canExpand ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'text-muted-foreground hover:text-foreground mt-1 inline-flex cursor-pointer items-center',
            'origin-left text-xs font-medium transition-[color,transform] duration-150 ease-out active:scale-[0.96]',
            'focus-visible:ring-ring/50 rounded-sm focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
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

export function MarkdownFrontmatterCard({
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
        'not-prose border-border bg-sidebar mb-6 rounded-md border px-4 py-3',
        className,
      )}
    >
      <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs leading-relaxed">
        {entries.map(([key, value]) => (
          <React.Fragment key={key}>
            <span className="text-muted-foreground/70 select-none">{key}</span>
            <FrontmatterValueBody value={value} />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
