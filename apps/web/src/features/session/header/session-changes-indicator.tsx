'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { STATUS_BG, STATUS_TEXT } from '@/components/ui/status';
import { useGitStatus } from '@/features/files/hooks/use-git-status';
import {
  CHANGE_STATUS_BADGE,
  useOpenChangeRequest,
  useSessionBaseRef,
} from '@/features/session/session-changes-shared';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { FileDiff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useState } from 'react';

export function SessionChangesIndicator({ sessionId }: { sessionId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const statusQuery = useGitStatus();
  const changedFiles = statusQuery.data ?? [];
  const changedCount = changedFiles.length;
  const baseRef = useSessionBaseRef(projectId, gitSessionId);
  const { asking, openChangeRequest } = useOpenChangeRequest(sessionId, baseRef);

  const [open, setOpen] = useState(false);

  if (changedCount === 0) return null;

  const viewChanges = () => {
    useSessionBrowserStore.getState().setView(sessionId, 'files');
    useKortixComputerStore.getState().setIsSidePanelOpen(true);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${changedCount} change${changedCount === 1 ? '' : 's'} in this version, not in ${baseRef} yet`}
          className="relative"
        >
          <span className="relative inline-flex">
            <FileDiff className="text-foreground size-4" />
            <span
              className="bg-kortix-orange ring-background absolute -top-1 -right-1 size-2 rounded-full ring-2"
              aria-hidden
            />
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[320px] overflow-hidden p-0">
        <div className="border-border border-b px-4 pt-4 pb-3">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md',
                STATUS_BG.warning,
                STATUS_TEXT.warning,
              )}
            >
              <FileDiff className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-foreground truncate text-sm font-semibold tracking-tight">
                {changedCount} change{changedCount === 1 ? '' : 's'}{' '}
                {tI18nHardcoded.raw(
                  'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextInThis7c956bd8',
                )}
              </h3>
              <p className="text-muted-foreground truncate text-xs">
                {tI18nHardcoded.raw(
                  'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextNotIn5d967721',
                )}
                <span className="font-mono">{baseRef}</span>{' '}
                {tI18nHardcoded.raw(
                  'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextVersionYet689021ee',
                )}
              </p>
            </div>
          </div>
          <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
            {tI18nHardcoded.raw(
              'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextThisSession009eeb83',
            )}{' '}
            <span className="text-foreground/80 font-mono">{baseRef}</span>
            {tI18nHardcoded.raw(
              'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextTheseChanges18316b37',
            )}{' '}
            <span className="text-foreground/80 font-mono">{baseRef}</span>{' '}
            {tI18nHardcoded.raw(
              'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextVersionYet922de6bd',
            )}
          </p>
        </div>

        <div className="max-h-40 overflow-auto px-1.5 py-1.5">
          {changedFiles.map((file) => {
            const badge = CHANGE_STATUS_BADGE[file.status] ?? CHANGE_STATUS_BADGE.modified;
            const name = file.path.split('/').pop() || file.path;
            const dir = file.path.slice(0, file.path.length - name.length);
            return (
              <div key={file.path} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs">
                <span
                  className={cn('w-3 shrink-0 text-center font-mono font-semibold', badge.cls)}
                  title={badge.label}
                >
                  {badge.letter}
                </span>
                <span className="text-foreground/90 truncate font-medium">{name}</span>
                {dir && (
                  <span className="text-muted-foreground/50 truncate font-mono text-[10px]">
                    {dir.replace(/\/$/, '')}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-border flex items-center gap-2 border-t px-3 py-2.5">
          <Button size="sm" onClick={openChangeRequest} disabled={asking}>
            {asking ? <Loading className="size-3.5" /> : <FileDiff className="size-3.5" />}
            {tI18nHardcoded.raw(
              'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextOpenChangedc3b8624',
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={viewChanges}>
            {tI18nHardcoded.raw(
              'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextViewChangesaf192a3b',
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
