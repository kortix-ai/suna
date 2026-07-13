'use client';

/**
 * `ContextCard` — "what the agent LOOKED AT." Groups into the three buckets
 * `deriveContext` already partitions: files read, web sources, tools used.
 * Read-only rows (no navigation) — unlike Outputs, there's nothing here to
 * open, only to acknowledge happened.
 */

import { FileText, Globe, Wrench } from 'lucide-react';
import type { ContextItem } from '../shared/derive-panels';
import { PanelCard } from './panel-card';

function ContextGroup({
  label,
  items,
  icon: Ico,
}: {
  label: string;
  items: ContextItem[];
  icon: typeof FileText;
}) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">
        {label} <span className="tabular-nums">({items.length})</span>
      </span>
      <ul className="flex flex-col gap-0.5">
        {items.map((it) => (
          <li
            key={it.callID}
            // The real URL (when this row is a web source) rides along as a
            // native tooltip only — never rendered as the row's label.
            title={it.url}
            className="flex min-h-8 items-center gap-2 px-2 py-1"
          >
            <Ico className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-foreground truncate text-sm">{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ContextCard({
  files,
  web,
  tools,
}: {
  files: ContextItem[];
  web: ContextItem[];
  tools: ContextItem[];
}) {
  const total = files.length + web.length + tools.length;

  return (
    <PanelCard
      title="Context"
      count={total}
      isEmpty={total === 0}
      emptyArt={<ContextArt />}
      emptyText="Track tools and referenced files used in this task."
    >
      <div className="flex flex-col gap-4">
        <ContextGroup label="Files read" items={files} icon={FileText} />
        <ContextGroup label="Web sources" items={web} icon={Globe} />
        <ContextGroup label="Tools used" items={tools} icon={Wrench} />
      </div>
    </PanelCard>
  );
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
