'use client';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { FadedScrollArea } from '../../../primitives/faded-scroll-area';
import { Label } from '../../../primitives/label';
import Loading from '../../../primitives/loading';
import { Popover, PopoverContent, PopoverTrigger } from '../../../primitives/popover';
import { cn } from '../../../lib/utils';
import type { ProjectBranch } from '@kortix/sdk';
import {
  ArrowDownLeftIcon as ArrowDownLeft,
  ArrowUpRightIcon as ArrowUpRight,
  CheckIcon as Check,
  CaretUpDownIcon as ChevronsUpDown,
  StackIcon as Layers,
  MagnifyingGlassIcon as Search,
} from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useMemo, useState } from 'react';
import { useProjectContext } from '../context';
import { useBranches } from '../hooks/use-branches';
import { useVersionStore } from '../store/version-store';
import { groupVersions, versionMatches, versionTitle } from './version-selector-logic';

/** Shared formatter, hoisted so each row render does not rebuild the Intl
 *  machinery. Same options as the old `toLocaleDateString` call — identical output. */
const commitDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

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

  const filtered = useMemo(
    () => (data?.branches ?? []).filter((b) => versionMatches(b, query)),
    [data?.branches, query],
  );

  const { primary, others, archived } = useMemo(() => groupVersions(filtered), [filtered]);

  const activeBranch = data?.branches.find((b) => b.name === activeRef);
  const activeLabel = activeBranch ? versionTitle(activeBranch) : activeRef;

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
          className="max-w-48 min-w-30 shrink-0 justify-between"
          title={tHardcodedUi.raw(
            'featuresProjectFilesComponentsVersionSelector.line88JsxAttrTitleSwitchVersion',
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Layers className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{activeLabel || 'Version'}</span>
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
          <Search className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tHardcodedUi.raw(
              'featuresProjectFilesComponentsVersionSelector.line112JsxAttrPlaceholderFindAVersion',
            )}
            className="text-foreground placeholder:text-muted-foreground h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm outline-none"
            autoFocus
          />
        </div>

        <div className="h-[520px] max-h-[calc(100vh-8rem)] min-h-0 shrink">
          <FadedScrollArea fadeColor="from-popover" className="h-full overscroll-contain">
            {isLoading && (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-xs">
                <Loading className="size-3.5" />
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
              <div className={cn('space-y-3 p-3', others.length + archived.length > 0 ? 'pb-0' : 'pb-3')}>
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
              <div className={cn('space-y-3 p-3', archived.length > 0 ? 'pb-0' : 'pb-3')}>
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

            {archived.length > 0 && (
              <div className="space-y-3 p-3 pb-3">
                <Label>{tHardcodedUi.raw('i18nComplete.textbdb86505f806')}</Label>
                {archived.map((b) => (
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
  const date = branch.committed_at ? commitDateFormatter.format(new Date(branch.committed_at)) : '';
  const title = versionTitle(branch);
  const agent = branch.session?.agent_name;

  return (
    <button
      type="button"
      onClick={onClick}
      // The id stays one hover away, and search still finds it.
      title={title === branch.name ? undefined : branch.name}
      className={cn(
        'border-border bg-popover hover:bg-foreground/4 flex w-full cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-left',
        isActive && 'bg-primary/5',
      )}
    >
      <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {isActive ? (
          <Check className="text-primary size-3.5" />
        ) : (
          <Layers className="text-muted-foreground size-3.5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          {branch.is_default && (
            <Badge variant="kortix" size="xs">
              {tHardcodedUi.raw('i18nComplete.texteb814be3ca3b')}
            </Badge>
          )}
          {branch.session?.deleted && (
            <Badge variant="outline" size="xs">
              {tHardcodedUi.raw('i18nComplete.textb48ff39c2e0f')}
            </Badge>
          )}
        </div>

        <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          {agent && <span className="truncate">{agent}</span>}
          {agent && date && <span className="text-muted-foreground">·</span>}
          {date && (
            <span>
              {tHardcodedUi.raw('i18nComplete.text3a5ecca188c0')} {date}
            </span>
          )}
          {!branch.is_default && branch.ahead != null && branch.behind != null && (
            <>
              {date && <span className="text-muted-foreground">·</span>}
              <span
                className="inline-flex items-center gap-1 tabular-nums"
                title={tHardcodedUi.raw(
                  'featuresProjectFilesComponentsVersionSelector.line234JsxAttrTitleAheadBehindMainVersion',
                )}
              >
                <span className="text-kortix-green inline-flex items-center gap-0.5">
                  <ArrowUpRight className="h-2.5 w-2.5" />
                  {branch.ahead}
                </span>
                <span className="text-kortix-red inline-flex items-center gap-0.5">
                  <ArrowDownLeft className="h-2.5 w-2.5" />
                  {branch.behind}
                </span>
              </span>
            </>
          )}
        </div>

        {branch.subject && (
          <div className="text-muted-foreground mt-0.5 truncate text-xs">{branch.subject}</div>
        )}
      </div>
    </button>
  );
}
