'use client';

import { useMemo, useRef, useState } from 'react';
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
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/design-system';

import { useBranches } from '../hooks/use-branches';
import { useProjectContext } from '../context';
import { useVersionStore } from '../store/version-store';
import type { ProjectBranch } from '@/lib/projects-client';

export function VersionSelector() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const activeRef = ctx?.ref ?? '';

  const setVersion = useVersionStore((s) => s.setVersion);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

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

  const displayLabel = activeRef
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(activeRef)
      ? activeRef.slice(0, 8)
      : activeRef
    : 'version';

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery('');
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Switch version"
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
          <span className="max-w-[14rem] truncate font-mono text-sm font-medium text-foreground">
            {displayLabel}
          </span>
          {/* {isOnMain ? (
            <span className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-muted-foreground/60">
              main
            </span>
          ) : null} */}
          <ChevronsUpDown
            className="size-3 shrink-0 text-muted-foreground/40 transition-colors group-hover/v:text-muted-foreground"
            aria-hidden
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={6}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' && e.key !== 'Enter' && e.key !== 'ArrowDown') {
                e.stopPropagation();
              }
            }}
            placeholder="Find a version…"
            className="h-6 flex-1 bg-transparent font-sans text-[0.8rem] text-foreground outline-none placeholder:text-muted-foreground/50"
            autoFocus
          />
        </div>

        <div className="max-h-[360px] overflow-y-auto py-1">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 font-mono text-[0.68rem] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading versions…
            </div>
          ) : error ? (
            <div className="py-8 text-center font-mono text-[0.68rem] text-muted-foreground">
              Failed to load versions
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center font-mono text-[0.68rem] text-muted-foreground">
              No versions match {query ? `“${query}”` : ''}
            </div>
          ) : (
            <>
              {primary.length > 0 ? (
                <>
                  <DropdownMenuLabel>
                    Main version
                  </DropdownMenuLabel>
                  {primary.map((b) => (
                    <VersionRow
                      key={b.name}
                      branch={b}
                      isActive={activeRef === b.name}
                      onSelect={() => handleSelect(b.name)}
                    />
                  ))}
                </>
              ) : null}

              {primary.length > 0 && others.length > 0 ? (
                <DropdownMenuSeparator className="my-1" />
              ) : null}

              {others.length > 0 ? (
                <>
                  <DropdownMenuLabel>
                    Other versions
                  </DropdownMenuLabel>
                  {others.map((b) => (
                    <VersionRow
                      key={b.name}
                      branch={b}
                      isActive={activeRef === b.name}
                      onSelect={() => handleSelect(b.name)}
                    />
                  ))}
                </>
              ) : null}
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VersionRow({
  branch,
  isActive,
  onSelect,
}: {
  branch: ProjectBranch;
  isActive: boolean;
  onSelect: () => void;
}) {
  const date = branch.committed_at
    ? new Date(branch.committed_at).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : '';

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    branch.name,
  );
  const label = isUuid ? `${branch.name.slice(0, 8)}…` : branch.name;

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className={cn(
        'flex items-start gap-2.5 px-3 py-2',
        isActive && 'bg-muted/40',
      )}
    >
      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
        {isActive ? (
          <Check className="size-3.5 text-foreground" />
        ) : (
          <GitBranch className="size-3.5 text-muted-foreground/50" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[0.8rem] font-medium text-foreground">
            {label}
          </span>
          {branch.is_default ? (
            <span className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-muted-foreground/70">
              main
            </span>
          ) : null}
        </div>

        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[0.66rem] text-muted-foreground">
          {branch.tip_short ? <span>{branch.tip_short}</span> : null}
          {date ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span>{date}</span>
            </>
          ) : null}
          {!branch.is_default && branch.ahead != null && branch.behind != null ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="inline-flex items-center gap-0.5 text-emerald-500">
                <ArrowUpRight className="size-2.5" />
                {branch.ahead}
              </span>
              <span className="inline-flex items-center gap-0.5 text-rose-500">
                <ArrowDownLeft className="size-2.5" />
                {branch.behind}
              </span>
            </>
          ) : null}
        </div>

        {branch.subject ? (
          <div className="mt-0.5 truncate font-sans text-[0.7rem] text-muted-foreground/70">
            {branch.subject}
          </div>
        ) : null}
      </div>
    </DropdownMenuItem>
  );
}
