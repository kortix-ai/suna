'use client';

/**
 * `ContextCard` — "what the agent LOOKED AT," as badges.
 *
 * It used to be three labelled lists ("Web sources", "Files read", "Tools
 * used") stacked inside the card, which turned a summary into a wall of rows.
 * Now the card holds one flat wrap of badges — a source is a *thing the agent
 * consulted*, and a badge says that in one glance. Tapping one slides open the
 * `DetailLayer` — the same surface a Progress step opens, so there is exactly
 * one rule to learn.
 *
 * In the detail, web sources get the treatment they deserve — the site's own
 * favicon, the page title, and the real URL — instead of being flattened into
 * a bare line of text.
 */

import { Badge } from '@/components/ui/badge';
import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import { cn } from '@/lib/utils';
import { FileText, Globe } from 'lucide-react';
import type { ContextItem } from '../shared/derive-panels';
import type { StepFamily } from '../shared/narration';
import { familyForTool } from '../shared/narration';
import type { Detail } from './detail-view';
import { ToolParts } from './detail-view';
import { PanelCard } from './panel-card';
import { StepIcon } from './step-icon';

/** One badge = one group of things the agent consulted. */
interface ContextGroup {
  id: string;
  label: string;
  count: number;
  icon: React.ReactNode;
  /** What the detail view shows when this badge is opened. */
  body: React.ReactNode;
}

export function ContextCard({
  files,
  web,
  tools,
  sessionId,
  onOpenDetail,
}: {
  files: ContextItem[];
  web: ContextItem[];
  tools: ContextItem[];
  sessionId: string;
  /** Detail replaces the whole panel — so the panel, not this card, owns it. */
  onOpenDetail: (detail: Detail) => void;
}) {
  const groups: ContextGroup[] = [];

  if (web.length) {
    groups.push({
      id: 'web',
      label: 'Web sources',
      count: web.length,
      icon: <Globe className="text-muted-foreground size-3.5 shrink-0" />,
      body: <WebSourceList items={web} />,
    });
  }

  if (files.length) {
    groups.push({
      id: 'files',
      label: 'Files read',
      count: files.length,
      icon: <FileText className="text-muted-foreground size-3.5 shrink-0" />,
      body: <FileList items={files} />,
    });
  }

  // Every other tool the agent reached for keeps its own badge, with the same
  // family glyph it wears in the Progress stepper — one tool, one icon, both
  // places. A tool badge's detail shows what it actually did.
  for (const tool of tools) {
    const family: StepFamily = (familyForTool(tool.parts?.[0]?.tool ?? '') as StepFamily) ?? 'other';
    groups.push({
      id: tool.callID,
      label: tool.label,
      count: tool.parts?.length ?? 1,
      icon: <StepIcon family={family} status="done" />,
      body: <ToolParts parts={tool.parts ?? []} sessionId={sessionId} />,
    });
  }

  return (
    <PanelCard
      title="Context"
      count={files.length + web.length + tools.length}
      isEmpty={groups.length === 0}
      emptyArt={<ContextArt />}
      emptyText="Track tools and referenced files used in this task."
      // The only card with a full p-4 body: badges are free-floating pills with
      // no inset of their own, so the padding has to come from here.
      contentClassName="border-border border-t p-4"
    >
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() =>
              onOpenDetail({ key: g.id, title: g.label, icon: g.icon, body: g.body })
            }
            className="border-border bg-popover hover:bg-muted flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border py-1 pr-2 pl-2.5 transition-[background-color,transform] active:scale-[0.98]"
          >
            {g.icon}
            <span className="text-foreground truncate text-sm">{g.label}</span>
            <Badge variant="secondary" size="sm" className="tabular-nums">
              {g.count}
            </Badge>
          </button>
        ))}
      </div>
    </PanelCard>
  );
}

const ROW = cn(
  'flex min-h-12 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left',
  'bg-muted/40 transition-colors',
);

/**
 * Favicon, then the page title, then its URL pushed to the far edge — the
 * title is what you're looking for and the URL is what confirms it, so they
 * sit at opposite ends of the row rather than stacked on top of each other.
 * The title takes the slack; the URL keeps its own width and never squeezes
 * the title out.
 */
function WebSourceList({ items }: { items: ContextItem[] }) {
  return (
    <ul className="flex min-w-0 flex-col gap-1.5">
      {items.map((it) => (
        <li key={it.callID}>
          <a
            href={it.url}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(ROW, 'hover:bg-muted cursor-pointer justify-between gap-4')}
          >
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <FaviconAvatar value={it.url ?? it.label} size="sm" alt="" className="shrink-0" />
              <span className="text-foreground truncate text-sm">{it.label}</span>
            </span>
            {it.url && (
              <span className="text-muted-foreground max-w-[45%] shrink-0 truncate text-xs">
                {prettyUrl(it.url)}
              </span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

function FileList({ items }: { items: ContextItem[] }) {
  return (
    <ul className="flex min-w-0 flex-col gap-1.5">
      {items.map((it) => (
        <li key={it.callID} className={ROW}>
          <span className="bg-muted/70 flex size-7 shrink-0 items-center justify-center rounded-md">
            <FileText className="text-muted-foreground size-3.5" />
          </span>
          <span className="text-foreground truncate text-sm">{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The URL, minus the ceremony a non-technical reader doesn't need. */
function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Soft placeholder art — overlapping note cards, matching the reference. */
function ContextArt() {
  return (
    <div aria-hidden className="relative h-16 w-24">
      <span className="border-border/60 bg-muted/30 absolute top-3 left-0 h-10 w-8 rounded-sm border" />
      <span className="border-border/60 bg-muted/40 absolute top-1.5 left-6 h-12 w-9 rounded-sm border" />
      <span className="border-border/60 absolute top-3 left-14 h-10 w-8 rounded-sm border border-dashed bg-transparent" />
    </div>
  );
}
