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
import { GitPullRequestArrow } from 'lucide-react';
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
          <svg
            width="200"
            height="200"
            viewBox="0 0 200 200"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="text-foreground size-4"
          >
            <path
              d="M41.6667 75C55.4738 75 66.6667 63.8071 66.6667 50C66.6667 36.1929 55.4738 25 41.6667 25C27.8596 25 16.6667 36.1929 16.6667 50C16.6667 63.8071 27.8596 75 41.6667 75Z"
              stroke="currentColor"
              strokeWidth="16.6667"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M41.6667 75V175"
              stroke="currentColor"
              strokeWidth="16.6667"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M100 50H141.667C146.087 50 150.326 51.7559 153.452 54.8816C156.577 58.0072 158.333 62.2464 158.333 66.6667V125"
              stroke="currentColor"
              strokeWidth="16.6667"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M158.333 175C172.14 175 183.333 163.807 183.333 150C183.333 136.193 172.14 125 158.333 125C144.526 125 133.333 136.193 133.333 150C133.333 163.807 144.526 175 158.333 175Z"
              stroke="currentColor"
              strokeWidth="16.6667"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="fill-kortix-orange stroke-kortix-orange"
            />
            <path
              d="M125 75L100 50L125 25"
              stroke="currentColor"
              strokeWidth="16.6667"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
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
              <svg
                width="200"
                height="200"
                viewBox="0 0 200 200"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="text-foreground size-4"
              >
                <path
                  d="M41.6667 75C55.4738 75 66.6667 63.8071 66.6667 50C66.6667 36.1929 55.4738 25 41.6667 25C27.8596 25 16.6667 36.1929 16.6667 50C16.6667 63.8071 27.8596 75 41.6667 75Z"
                  stroke="currentColor"
                  strokeWidth="16.6667"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M41.6667 75V175"
                  stroke="currentColor"
                  strokeWidth="16.6667"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M100 50H141.667C146.087 50 150.326 51.7559 153.452 54.8816C156.577 58.0072 158.333 62.2464 158.333 66.6667V125"
                  stroke="currentColor"
                  strokeWidth="16.6667"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M158.333 175C172.14 175 183.333 163.807 183.333 150C183.333 136.193 172.14 125 158.333 125C144.526 125 133.333 136.193 133.333 150C133.333 163.807 144.526 175 158.333 175Z"
                  stroke="currentColor"
                  strokeWidth="16.6667"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M125 75L100 50L125 25"
                  stroke="currentColor"
                  strokeWidth="16.6667"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
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
            {asking ? (
              <Loading className="size-3.5" />
            ) : (
              <GitPullRequestArrow className="size-3.5" />
            )}
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
