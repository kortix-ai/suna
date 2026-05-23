'use client';

import { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronsUpDown,
  GitBranch,
  Loader2,
  Search,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useBranches } from '../hooks/use-branches';
import { useProjectContext } from '../context';
import { useVersionStore } from '../store/version-store';
import type { ProjectBranch } from '@/lib/projects-client';

/**
 * Version (Git branch) picker — Vercel-style chip trigger.
 *
 * Trigger: pill with branch icon, version name, optional "Main" tag, chevron.
 * Popover: search + list, with the default branch pinned at the top.
 */
export function VersionSelector() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const activeRef = ctx?.ref ?? '';

  const setVersion = useVersionStore((s) => s.setVersion);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Fetch lazily — the picker is usually closed, but the trigger needs to
  // know whether the active version is the default to render the "Main" tag.
  const { data, isLoading, error } = useBranches({ enabled: open || activeRef !== '' });

  const defaultBranch = data?.default_branch ?? activeRef;
  const isOnMain = activeRef === defaultBranch;

  const filtered = useMemo(() => {
    const branches = data?.branches ?? [];
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(trimmed));
  }, [data?.branches, query]);

  const { primary, others } = useMemo(() => {
    const primary: ProjectBranch[] = [];
    const others: ProjectBranch[] = [];
    for (const b of filtered) {
      if (b.is_default) primary.push(b);
      else others.push(b);
    }
    return { primary, others };
  }, [filtered]);

  const handleSelect = (branchName: string) => {
    setVersion(projectId, branchName === defaultBranch ? null : branchName);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'group inline-flex items-center gap-2 h-8 pl-2 pr-1.5 rounded-2xl',
            'border border-border/60 bg-background hover:bg-muted/40',
            'transition-colors',
            'text-[12.5px] font-medium',
            'shrink-0 min-w-0 max-w-[280px]',
          )}
          title="Switch version"
        >
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground/80 shrink-0" />
          <span className="truncate">{activeRef || 'Version'}</span>
          {isOnMain && (
            <span className="hidden sm:inline-flex items-center rounded-full bg-muted px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              Main
            </span>
          )}
          <ChevronsUpDown className="h-3 w-3 text-muted-foreground/60 shrink-0 ml-0.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[340px] p-0 overflow-hidden"
      >
        {/* Search */}
        <div className="flex items-center gap-1.5 px-3 h-10 border-b border-border/40">
          <Search className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a version…"
            className="flex-1 min-w-0 h-7 bg-transparent border-0 outline-none px-0 text-[12.5px] text-foreground placeholder:text-muted-foreground/50"
            autoFocus
          />
        </div>

        <div className="max-h-[380px] overflow-y-auto overscroll-contain">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading versions…
            </div>
          )}

          {error && !isLoading && (
            <div className="py-8 px-4 text-center text-xs text-muted-foreground">
              Failed to load versions
            </div>
          )}

          {!isLoading && !error && filtered.length === 0 && (
            <div className="py-8 px-4 text-center text-xs text-muted-foreground">
              No versions match {query ? `“${query}”` : ''}
            </div>
          )}

          {primary.length > 0 && (
            <div>
              <SectionLabel>Main version</SectionLabel>
              {primary.map((b) => (
                <VersionRow
                  key={b.name}
                  branch={b}
                  isActive={activeRef === b.name}
                  onClick={() => handleSelect(b.name)}
                />
              ))}
            </div>
          )}

          {others.length > 0 && (
            <div className="border-t border-border/30">
              <SectionLabel>Other versions</SectionLabel>
              {others.map((b) => (
                <VersionRow
                  key={b.name}
                  branch={b}
                  isActive={activeRef === b.name}
                  onClick={() => handleSelect(b.name)}
                />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/60">
      {children}
    </div>
  );
}

function VersionRow({
  branch,
  isActive,
  onClick,
}: {
  branch: ProjectBranch;
  isActive: boolean;
  onClick: () => void;
}) {
  const date = branch.committed_at
    ? new Date(branch.committed_at).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : '';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-2.5 w-full px-3 py-2 text-left',
        'hover:bg-muted/40 transition-colors',
        isActive && 'bg-primary/[0.05]',
      )}
    >
      <div className="mt-0.5 flex w-4 shrink-0 items-center justify-center">
        {isActive ? (
          <Check className="h-3.5 w-3.5 text-primary" />
        ) : (
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium text-foreground truncate">
            {branch.name}
          </span>
          {branch.is_default && (
            <span className="inline-flex items-center rounded bg-muted px-1 py-px text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              Main
            </span>
          )}
        </div>

        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
          <span className="font-mono">{branch.tip_short}</span>
          {date && <span className="text-muted-foreground/40">·</span>}
          {date && <span>{date}</span>}
          {!branch.is_default && branch.ahead != null && branch.behind != null && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span
                className="inline-flex items-center gap-1"
                title="Ahead / behind main version"
              >
                <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-500">
                  <ArrowUpRight className="h-2.5 w-2.5" />
                  {branch.ahead}
                </span>
                <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-500">
                  <ArrowDownLeft className="h-2.5 w-2.5" />
                  {branch.behind}
                </span>
              </span>
            </>
          )}
        </div>

        {branch.subject && (
          <div className="text-[11px] text-muted-foreground/70 mt-0.5 truncate">
            {branch.subject}
          </div>
        )}
      </div>
    </button>
  );
}
