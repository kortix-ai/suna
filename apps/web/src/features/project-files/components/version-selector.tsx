'use client';

import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ProjectBranch } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { ChevronsUpDown } from '@mynaui/icons-react';
import { ArrowDownLeft, ArrowUpRight, Check, GitBranch, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useProjectContext } from '../context';
import { useBranches } from '../hooks/use-branches';
import { useVersionStore } from '../store/version-store';

export function VersionSelector() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const activeRef = ctx?.ref ?? '';

  const setVersion = useVersionStore((s) => s.setVersion);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const { data, isLoading, error } = useBranches({ enabled: open || activeRef !== '' });

  const defaultBranch = data?.default_branch ?? activeRef;
  const isOnMain = activeRef === defaultBranch;

  const filtered = useMemo(() => {
    const branches = data?.branches ?? [];
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return branches;
    return branches.filter(
      (b) => b.name.toLowerCase().includes(trimmed) || b.subject.toLowerCase().includes(trimmed),
    );
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
        <Button
          variant="outline-ghost"
          type="button"
          size="sm"
          className={cn('w-30 max-w-[300px] min-w-0 shrink-0 justify-between')}
          title={tHardcodedUi.raw(
            'featuresProjectFilesComponentsVersionSelector.line88JsxAttrTitleSwitchVersion',
          )}
        >
          <div className="flex items-center gap-2">
            <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{activeRef || 'Version'}</span>
          </div>
          <ChevronsUpDown className="text-muted-foreground size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="flex w-[340px] flex-col overflow-hidden p-0"
      >
        <div className="border-border flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
          <Search className="text-muted-foreground/60 h-3.5 w-3.5 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tHardcodedUi.raw(
              'featuresProjectFilesComponentsVersionSelector.line112JsxAttrPlaceholderFindAVersion',
            )}
            className="text-foreground placeholder:text-muted-foreground/50 h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm outline-none"
            autoFocus
          />
        </div>

        <div className="h-[520px] max-h-[calc(100vh-8rem)] min-h-0 shrink">
          <FadedScrollArea fadeColor="from-popover" className="h-full overscroll-contain">
            {isLoading && (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-xs">
                <Loading className="size-3.5 animate-spin" />
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsVersionSelector.line122JsxTextLoadingVersions',
                )}
              </div>
            )}

            {error && !isLoading && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsVersionSelector.line128JsxTextFailedToLoadVersions',
                )}
              </div>
            )}

            {!isLoading && !error && filtered.length === 0 && (
              <div className="text-muted-foreground px-4 py-8 text-center text-xs">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsVersionSelector.line134JsxTextNoVersionsMatch',
                )}{' '}
                {query ? `“${query}”` : ''}
              </div>
            )}

            {primary.length > 0 && (
              <div className={cn('space-y-3 p-3', others.length > 0 ? 'pb-0' : 'pb-3')}>
                <Label>
                  {tHardcodedUi.raw(
                    'featuresProjectFilesComponentsVersionSelector.line140JsxTextMainVersion',
                  )}
                </Label>
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
              <div className="space-y-3 p-3 pb-3">
                <Label>
                  {tHardcodedUi.raw(
                    'featuresProjectFilesComponentsVersionSelector.line154JsxTextOtherVersions',
                  )}
                </Label>
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
          </FadedScrollArea>
        </div>
      </PopoverContent>
    </Popover>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        'border-border bg-popover hover:bg-foreground/4 flex w-full cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-left',
        isActive && 'bg-primary/5',
      )}
    >
      <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {isActive ? (
          <Check className="text-primary size-3.5" />
        ) : (
          <GitBranch className="text-muted-foreground size-3.5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{branch.name}</span>
          {branch.is_default && (
            <span className="bg-muted text-muted-foreground inline-flex items-center rounded px-1 py-px text-xs font-semibold tracking-wider uppercase">
              Main
            </span>
          )}
        </div>

        <div className="text-muted-foreground/80 mt-0.5 flex items-center gap-1.5 text-xs">
          <span className="font-mono">{branch.tip_short}</span>
          {date && <span className="text-muted-foreground/40">·</span>}
          {date && <span>{date}</span>}
          {!branch.is_default && branch.ahead != null && branch.behind != null && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span
                className="inline-flex items-center gap-1"
                title={tHardcodedUi.raw(
                  'featuresProjectFilesComponentsVersionSelector.line234JsxAttrTitleAheadBehindMainVersion',
                )}
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
          <div className="text-muted-foreground/70 mt-0.5 truncate text-xs">{branch.subject}</div>
        )}
      </div>
    </button>
  );
}
