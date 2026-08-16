'use client';

/**
 * `ContextCard` — "what the agent LOOKED AT," as rows.
 *
 * It used to be three labelled lists ("Web sources", "Files read", "Tools
 * used") stacked inside the card, which turned a summary into a wall of rows;
 * then one flat wrap of pills, which gave every group a different width and
 * left the counts scattered across the card with nothing to line them up.
 * Now each group is one full-width row — icon, name, count, chevron — the same
 * row language the Outputs card uses, so the two cards sharing one panel read
 * as one system. Tapping a row slides open the `DetailLayer` — the same
 * surface a Progress step opens, so there is exactly one rule to learn.
 *
 * In the detail, web sources get the treatment they deserve — the site's own
 * favicon, the page title, and the real URL — instead of being flattened into
 * a bare line of text.
 *
 * **Empty-state actions (Task 5).** An empty card used to be a dead promise —
 * a sentence with nothing to act on. Two quiet actions sit under it now:
 * "Add context" hands the user straight to the composer's attach flow
 * (`onAddContext`, a plain callback — see `easy-panel.tsx` for what it's
 * wired to), and "Connect apps" reveals `ConnectAppsStrip` (Task 6) in place.
 * The open/closed state for the strip is NOT local `useState` here — it's
 * hoisted to `EasyPanel` (`connectAppsOpen` / `onToggleConnectApps`) so this
 * component stays hook-free, which is what lets `context-card.test.tsx` keep
 * calling it as a plain function instead of mounting it for real.
 *
 * **Non-empty footer row (Task 7).** Once the card has real rows, the
 * empty-state buttons are gone (`PanelCard`'s `isEmpty` ternary renders
 * `emptyActions` XOR `children` — never both), so a quiet "Connect apps" row
 * sits after the group list instead — the same `ConnectAppsStrip` reveal,
 * the same `connectAppsOpen` / `onToggleConnectApps` state, just a second
 * toggle for it. Styled after the "N more files" fold row in
 * `outputs-card.tsx` (muted label, glyph in a `size-7` box, `hover:` lightens
 * to `text-foreground`) rather than the empty state's outlined `Button` —
 * this row is a footnote, not an invitation.
 *
 * Both toggles point `aria-controls` at the SAME strip container id
 * (`connectAppsStripId` below) — only one of the two branches this id lives
 * in is ever mounted at once (the `isEmpty` ternary again), so the id stays
 * unique in the DOM despite two possible toggles for it.
 *
 * **Neither toggle renders without a `projectId`.** `ConnectAppsStrip` needs
 * one to declare a connector against and returns `null` without it, so a
 * toggle rendered anyway is a control that reveals nothing: `aria-expanded`
 * flips, an empty container mounts, and the user is told something opened
 * that did not. There is no project-less version of connecting an app, so the
 * affordance is absent rather than inert.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import { getFileIcon } from '@/features/project-files';
import { cn } from '@/lib/utils';
import {
  CaretRightIcon as ChevronRight,
  FileTextIcon as FileText,
  GlobeIcon as Globe,
  PlugsConnectedIcon as PlugsConnected,
  PlusIcon as Plus,
} from '@phosphor-icons/react';
import type { ContextItem } from '../shared/derive-panels';
import type { StepFamily } from '../shared/narration';
import { familyForTool, narrateFailedStep, narrateStep } from '../shared/narration';
import { ConnectAppsStrip } from './connect-apps-strip';
import type { Detail } from './detail-view';
import { ToolParts } from './detail-view';
import { PanelCard } from './panel-card';
import { StepIcon } from './step-icon';

/** One row = one group of things the agent consulted. */
interface ContextGroup {
  id: string;
  label: string;
  count: number;
  icon: React.ReactNode;
  /** What the detail view shows when this row is opened. */
  body: React.ReactNode;
}

export function ContextCard({
  files,
  web,
  tools,
  sessionId,
  onOpenDetail,
  onOpenFile,
  onAddContext,
  projectId,
  connectAppsOpen,
  onToggleConnectApps,
}: {
  files: ContextItem[];
  web: ContextItem[];
  tools: ContextItem[];
  sessionId: string;
  /** Detail replaces the whole panel — so the panel, not this card, owns it. */
  onOpenDetail: (detail: Detail) => void;
  /** Opens a "Files read" row in the file viewer, with the ordered path list
   *  of every OTHER openable row in the group so the viewer can wire prev/next
   *  nav across the read set — see `FileList`. */
  onOpenFile: (path: string, allPaths: string[]) => void;
  /** Empty-state "Add context" button. A plain callback, same pattern as
   *  `onOpenFile` — this card grows no store dependency of its own; see
   *  `easy-panel.tsx` for what it's wired to. */
  onAddContext: () => void;
  /** For `ConnectAppsStrip`, when a "Connect apps" toggle has it open — the
   *  strip needs a project to declare a connector against. Undefined also
   *  removes both toggles; see this file's header comment. */
  projectId: string | undefined;
  /** Whether `ConnectAppsStrip` is open under the empty-state buttons. Owned
   *  by `EasyPanel`, not local state — see this file's header comment. */
  connectAppsOpen: boolean;
  onToggleConnectApps: () => void;
}) {
  // Shared by both toggles — see this file's header comment on why one id is
  // safe despite two possible triggers for it.
  const connectAppsStripId = `context-card-connect-apps-${sessionId}`;
  // No project, no connector to declare — so no toggle either, in EITHER
  // branch. See this file's header comment.
  const canConnectApps = Boolean(projectId);

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
      body: <FileList items={files} onOpenFile={onOpenFile} />,
    });
  }

  // Every other tool the agent reached for keeps its own row, with the same
  // family glyph it wears in the Progress stepper — one tool, one icon, both
  // places. A tool row's detail shows what it actually did.
  for (const tool of tools) {
    const family: StepFamily =
      (familyForTool(tool.parts?.[0]?.tool ?? '') as StepFamily) ?? 'other';
    // `deriveContext` skips *fully* errored calls, but this row aggregates ALL
    // calls to that tool — one failed call among several is exactly what a
    // status="done" glyph would hide (failed-call aggregation).
    const failed = (tool.parts ?? []).some(
      (p) => (p.state as { status?: string } | undefined)?.status === 'error',
    );
    // The row's detail opens straight onto raw tool views (W3) — a plain
    // sentence above them, in the same voice the Progress stepper narrates
    // with, is what tells a non-technical reader what they're looking at
    // before they have to parse a diff or a JSON blob. Reuses `narrateStep`/
    // `narrateFailedStep` — the same pair `group-steps.ts`'s `finalize` calls
    // for the Progress card's own step label — rather than a second sentence
    // table (the rule `narration.ts:12-14` and `derive-panels.ts:1-14` both
    // enforce).
    const summary = failed
      ? narrateFailedStep(family, tool.parts ?? [])
      : narrateStep(family, tool.parts ?? []);
    groups.push({
      id: tool.callID,
      label: tool.label,
      count: tool.parts?.length ?? 1,
      icon: <StepIcon family={family} status={failed ? 'error' : 'done'} />,
      body: <ToolParts parts={tool.parts ?? []} sessionId={sessionId} summary={summary} />,
    });
  }

  return (
    <PanelCard
      title="Context"
      count={files.length + web.length + tools.length}
      isEmpty={groups.length === 0}
      emptyArt={<ContextArt />}
      emptyText="Track tools and referenced files used in this task."
      emptyActions={
        <div className="flex w-full flex-col items-stretch gap-3">
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onAddContext}>
              <Plus className="size-3.5" />
              Add context
            </Button>
            {canConnectApps && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={onToggleConnectApps}
                aria-expanded={connectAppsOpen}
                aria-controls={connectAppsStripId}
              >
                <PlugsConnected className="size-3.5" />
                Connect apps
              </Button>
            )}
          </div>
          <ConnectAppsReveal
            id={connectAppsStripId}
            open={connectAppsOpen}
            projectId={projectId}
            className="text-left"
          />
        </div>
      }
      // The same dense gutter Outputs uses. Rows carry their own inset, so the
      // body only has to keep them off the card's edge — a full `p-4` frame
      // belonged to free-floating pills, not to a list.
      contentClassName="border-border border-t px-2 py-2"
    >
      <ul className="flex flex-col gap-0">
        {groups.map((g) => (
          <li key={g.id} className="flex items-center">
            <button
              type="button"
              onClick={() =>
                onOpenDetail({ key: g.id, title: g.label, icon: g.icon, body: g.body })
              }
              className="hover:bg-accent -mx-0.5 flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-sm px-1 py-1.5 text-left transition-[background-color,transform] active:scale-[0.98]"
            >
              {/* A fixed leading box rather than the bare glyph: the group icons
                  are not one size (`size-3.5` here, `size-4` from `StepIcon`),
                  so without it every row's label would start at its own x. */}
              <span className="flex size-7 shrink-0 items-center justify-center">{g.icon}</span>
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{g.label}</span>
              <Badge variant="secondary" size="sm" className="tabular-nums">
                {g.count}
              </Badge>
              <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
            </button>
          </li>
        ))}
      </ul>
      {/* Non-empty footer row (Task 7) — see this file's header comment. Only
          reachable here, inside `children`, which `PanelCard` renders
          exclusively in the non-empty branch of its `isEmpty` ternary. */}
      {canConnectApps && (
        <>
          <button
            type="button"
            onClick={onToggleConnectApps}
            aria-expanded={connectAppsOpen}
            aria-controls={connectAppsStripId}
            // `color` rides the transition list because the label lightens on
            // hover, and the press scale is the one every row in both cards
            // uses — the same treatment the Outputs fold row carries, so a
            // footnote row moves identically wherever it appears.
            className="text-muted-foreground hover:text-foreground hover:bg-accent -mx-0.5 mt-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-1 py-1.5 text-left text-sm transition-[background-color,color,transform] active:scale-[0.98]"
          >
            <span className="flex size-7 shrink-0 items-center justify-center">
              <PlugsConnected className="size-3.5" />
            </span>
            <span className="truncate">Connect apps</span>
          </button>
          <ConnectAppsReveal
            id={connectAppsStripId}
            open={connectAppsOpen}
            projectId={projectId}
            className="mt-1"
          />
        </>
      )}
    </PanelCard>
  );
}

/**
 * The strip's container, in the one shape both toggles reveal it in.
 *
 * Two branches render it — under the empty-state buttons and under the footer
 * row — and they differ only in the wrapper's spacing class. Written twice,
 * the `id` (which `aria-controls` points at from both toggles) and the
 * open-gate were two copies to keep in step; here they are one.
 */
function ConnectAppsReveal({
  id,
  open,
  projectId,
  className,
}: {
  id: string;
  open: boolean;
  projectId: string | undefined;
  className: string;
}) {
  if (!open) return null;
  return (
    <div id={id} className={className}>
      <ConnectAppsStrip projectId={projectId} />
    </div>
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
        <li key={`${it.callID}:${it.url ?? it.label}`}>
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

/**
 * Every item carries its own per-extension glyph, the same tile the files
 * explorer and the Outputs card use — a `.md` reads as a `.md` here too, not
 * as an anonymous document. An item with a `path` opens in the file viewer:
 * clicking it calls `onOpenFile` with its own path plus the ordered path list
 * of every OTHER openable item in the group, so the viewer can wire prev/next
 * nav across the whole read set. An item without a `path` (`deriveContext`
 * only sets one when a `read` call actually resolved to a real file) stays a
 * plain row — nothing to open, so no button semantics to fake.
 */
function FileList({
  items,
  onOpenFile,
}: {
  items: ContextItem[];
  onOpenFile: (path: string, allPaths: string[]) => void;
}) {
  const allPaths = items.flatMap((it) => (it.path ? [it.path] : []));

  return (
    <ul className="flex min-w-0 flex-col gap-1.5">
      {items.map((it) =>
        it.path ? (
          <li key={it.callID}>
            <button
              type="button"
              onClick={() => onOpenFile(it.path as string, allPaths)}
              className={cn(
                ROW,
                'hover:bg-muted cursor-pointer transition-[background-color,transform] active:scale-[0.98]',
              )}
            >
              {/* `rounded-sm` (6px) inside the row's `rounded-md` (8px): a
                  tile is a status tile, and a tile that matched its own row's
                  radius read as a second card rather than a mark inside one.
                  Same tile the Outputs card's `OutputIcon` draws. */}
              <span className="bg-muted/70 flex size-7 shrink-0 items-center justify-center rounded-sm">
                {getFileIcon(basename(it.label), { className: 'size-4', variant: 'monochrome' })}
              </span>
              <span className="text-foreground truncate text-sm">{it.label}</span>
            </button>
          </li>
        ) : (
          <li key={it.callID} className={ROW}>
            <span className="bg-muted/70 flex size-7 shrink-0 items-center justify-center rounded-sm">
              <FileText className="text-muted-foreground size-3.5" />
            </span>
            <span className="text-foreground truncate text-sm">{it.label}</span>
          </li>
        ),
      )}
    </ul>
  );
}

/** Last path segment — `getFileIcon` keys off the extension, and `it.label`
 *  can occasionally BE a full path (`deriveContext`'s `label: ... || path`
 *  fallback), which would otherwise feed it directory segments instead of a
 *  filename. */
function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** The URL, minus the ceremony a non-technical reader doesn't need. */
function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Soft placeholder art — overlapping note cards, matching the reference.
 *
 * The hairlines are `border-border` at full alpha, not `border-border/60`.
 * Dark's `--border` (oklch 0.2686) already sits only 0.077 L above the card it
 * draws on (`--card`, oklch 0.1913) — that IS the theme's hairline contrast —
 * so taking 60% of it left the whole illustration effectively unrendered on
 * dark. The fills are the same story: `bg-muted/30` over dark's card resolves
 * to ~0.201 L against a 0.1913 ground, a 0.01 difference. `/50` and `/70` keep
 * the two-card depth order while landing where the eye can find them. Light is
 * unaffected in kind — `--border` is that theme's hairline too — and the fills
 * stay soft there because `--muted` is only 0.024 L off `--card`.
 */
function ContextArt() {
  return (
    <div aria-hidden className="relative h-16 w-24">
      <span className="border-border bg-muted/50 absolute top-3 left-0 h-10 w-8 rounded-sm border" />
      <span className="border-border bg-muted/70 absolute top-1.5 left-6 h-12 w-9 rounded-sm border" />
      <span className="border-border absolute top-3 left-14 h-10 w-8 rounded-sm border border-dashed bg-transparent" />
    </div>
  );
}
