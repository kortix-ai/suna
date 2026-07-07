'use client';

import { Icon as IconMynauiType, SparklesSolid, UsersGroupSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Bell, CalendarClock, Container, FileCode, Package, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { IconType } from 'react-icons/lib';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Icon } from '@/features/icon/icon';
import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { SessionWelcome } from '@/features/session/session-welcome';
import type { Command } from '@/hooks/opencode/use-opencode-sessions';
import type { CustomizeSection } from '@/lib/customize-sections';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';
import { cn } from '@/lib/utils';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listProjectAccessRequests,
  listProjectSandboxes,
  listProjectTriggers,
  type SandboxTemplate,
} from '@kortix/sdk/projects-client';
import { chalkColors } from '@kortix/shared';
import { HiOutlineViewGrid } from 'react-icons/hi';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export interface ProjectHomeSendOptions extends ComposerOptions {
  sandbox_slug?: string;
}

export function ProjectHome({
  projectId,
  onSend,
  busy,
}: {
  projectId: string;
  onSend: (
    text: string,
    files: AttachedFile[] | undefined,
    options?: ProjectHomeSendOptions,
  ) => void;
  busy: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);

  const sandboxesQuery = useQuery({
    queryKey: ['project-sandboxes', projectId],
    queryFn: () => listProjectSandboxes(projectId),
    ...Q,
  });
  const sandboxItems: SandboxTemplate[] = sandboxesQuery.data?.items ?? [];
  const defaultSlug = sandboxesQuery.data?.default_slug ?? 'default';
  const activeSlug = selectedSlug ?? defaultSlug;

  const showSandboxPicker = sandboxItems.length >= 1;
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const accessRequests = useQuery({
    queryKey: ['project-access-requests', projectId],
    queryFn: () => listProjectAccessRequests(projectId, { showErrors: false }),
    retry: false,
    ...Q,
  });
  const pendingAccessCount = accessRequests.data?.requests.length ?? 0;

  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
  const consumePrefill = useComposerPrefillStore((s) => s.consume);

  useEffect(() => {
    if (!pendingPrefill) return;
    consumePrefill(projectId);
    setPrefill({ text: pendingPrefill, id: Date.now() });
  }, [pendingPrefill, projectId, consumePrefill]);

  const handleSend = useCallback(
    (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => {
      onSend(text, files, {
        ...options,
        sandbox_slug: activeSlug,
      });
    },
    [activeSlug, onSend],
  );

  const handleCommand = useCallback(
    (cmd: Command, args: string | undefined, options: ComposerOptions) => {
      handleSend(`/${cmd.name}${args ? ` ${args}` : ''}`, undefined, options);
    },
    [handleSend],
  );

  const applySuggestion = (s: string) => {
    setPrefill({ text: s, id: Date.now() });
  };

  return (
    <div
      className={cn('bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden px-4.5')}
    >
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        <SessionWelcome />
      </div>
      {pendingAccessCount > 0 ? (
        <div className="absolute top-4 right-4 z-20">
          <Hint
            label={`${pendingAccessCount} pending access request${pendingAccessCount === 1 ? '' : 's'}`}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="bg-background/80 relative backdrop-blur-sm"
              onClick={() => openCustomize('members')}
              aria-label={`${pendingAccessCount} pending access request${pendingAccessCount === 1 ? '' : 's'}`}
            >
              <Bell className="size-4" />
              <Badge
                size="xs"
                variant="new"
                className="absolute -top-1 -right-1 min-w-5 px-1 tabular-nums"
              >
                {pendingAccessCount}
              </Badge>
            </Button>
          </Hint>
        </div>
      ) : null}

      <ProjectHomeWelcomeBody
        projectId={projectId}
        onPickSuggestion={applySuggestion}
        composer={
          <ComposerChatInput
            onSend={handleSend}
            onCommand={handleCommand}
            projectId={projectId}
            isBusy={busy}
            disabled={busy}
            // The home composer navigates to the new session on send — don't clear
            // it first (that only flashes an empty box before the route swaps, and
            // would drop the text on a gated send). The message rides across via the
            // start-stash and reappears as the instant shell's optimistic turn.
            clearOnSend={false}
            autoFocus
            cardClassName="rounded-xl"
            placeholder={tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrPlaceholder115e6c2d',
            )}
            prefill={prefill}
            toolbarSlot={
              showSandboxPicker ? (
                <SandboxPicker
                  items={sandboxItems}
                  activeSlug={activeSlug}
                  onSelect={setSelectedSlug}
                />
              ) : null
            }
          />
        }
      />
    </div>
  );
}

/**
 * The project-home empty-state body, laid out like Perplexity's home: the
 * centered welcome heading with the composer directly beneath it and the
 * starter-prompt chips right under the input — all vertically centered — while
 * the quiet "set up your project" pills sit at the bottom of the viewport.
 * Shared by the project index page AND the instant session shell's empty state
 * so a brand-new session opens onto the identical surface.
 */
export function ProjectHomeWelcomeBody({
  projectId,
  composer,
  onPickSuggestion,
}: {
  projectId: string;
  /** The composer input rendered in the hero position, directly under the heading. */
  composer?: ReactNode;
  /** When provided, starter-prompt chips render directly below the composer. */
  onPickSuggestion?: (text: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    ...Q,
  });
  const name = detail.data?.project?.name ?? '';
  const displayName = name.trim() || 'this project';

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="m-auto flex w-full max-w-[52rem] flex-col items-center gap-8 px-2 py-8 sm:px-4">
          <h1 className="text-muted-foreground max-w-2xl text-center text-4xl leading-[1.2] tracking-tight text-balance max-sm:text-3xl">
            Give <span className="text-foreground">{displayName}</span>{' '}
            {tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxTextSomething18ab9904',
            )}
          </h1>

          {composer || onPickSuggestion ? (
            <div className="flex w-full flex-col items-center">
              {composer}
              {onPickSuggestion ? <StarterPromptChips onPick={onPickSuggestion} /> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 justify-center px-4 pb-6">
        <ProjectHomeSections projectId={projectId} />
      </div>
    </div>
  );
}

/**
 * Starter prompt suggestions rendered as a centered, wrapping row of quiet
 * pills directly above the composer (Perplexity-style). All prompts are
 * visible at once — no scroll machinery; small screens show the first four.
 */
export function StarterPromptChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {STARTER_PROMPTS.map((p, i) => {
        const ChipIcon = p.icon;
        const chalk = chalkColors(p.label);
        return (
          <Button
            key={p.id}
            onClick={() => onPick(p.prompt)}
            variant="outline"
            size="sm"
            className={cn(
              'bg-background/60 shrink-0 gap-1.5 rounded-md backdrop-blur-sm',
              i >= 4 && 'max-sm:hidden',
            )}
          >
            <ChipIcon
              className="size-3.5 shrink-0"
              style={{ color: chalk.foreground }}
              aria-hidden
            />
            {p.label}
          </Button>
        );
      })}
    </div>
  );
}

function SandboxPicker({
  items,
  activeSlug,
  onSelect,
}: {
  items: SandboxTemplate[];
  activeSlug: string;
  onSelect: (slug: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const active = items.find((t) => t.slug === activeSlug) ?? items[0] ?? null;
  if (!active) return null;
  const ActiveIcon = active.is_default ? Container : active.has_image ? Package : FileCode;
  const activeStateTone =
    active.daytona_state === 'active'
      ? 'bg-kortix-green'
      : ['pulling', 'building'].includes(active.daytona_state)
        ? 'bg-kortix-blue'
        : active.daytona_state === 'missing'
          ? 'bg-muted-foreground/40'
          : 'bg-destructive';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={tI18nHardcoded.raw(
            'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrAria4acf4ecd',
          )}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-200"
        >
          <ActiveIcon className="size-3.5 shrink-0" />
          <span className="max-w-[7rem] truncate">{active.name}</span>
          <span className={cn('size-1.5 shrink-0 rounded-full', activeStateTone)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>
          {tI18nHardcoded.raw('autoFeaturesCoWorkerProjectLayoutProjectHomeJsxTextSandboxe9c5fbaa')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((tpl) => {
          const Icon = tpl.is_default ? Container : tpl.has_image ? Package : FileCode;
          const subtitle = tpl.is_default
            ? 'Platform default · clones workspace at boot'
            : tpl.has_image
              ? `Image: ${tpl.image}`
              : `Dockerfile: ${tpl.dockerfile_path}`;
          const stateTone =
            tpl.daytona_state === 'active'
              ? 'text-kortix-green'
              : ['pulling', 'building'].includes(tpl.daytona_state)
                ? 'text-kortix-blue'
                : tpl.daytona_state === 'missing'
                  ? 'text-muted-foreground'
                  : 'text-destructive';
          const stateLabel =
            tpl.daytona_state === 'active'
              ? 'Ready'
              : ['pulling', 'building'].includes(tpl.daytona_state)
                ? 'Building — session will wait'
                : tpl.daytona_state === 'missing'
                  ? 'Not built — first session will build it'
                  : tpl.daytona_state.replace('_', ' ');
          return (
            <DropdownMenuItem
              key={tpl.template_id ?? `tpl-${tpl.slug}`}
              className="flex items-start gap-2"
              onSelect={() => onSelect(tpl.slug)}
            >
              <Icon className="text-muted-foreground mt-0.5 size-4" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{tpl.name}</span>
                  {tpl.slug === activeSlug && (
                    <Badge variant="outline" size="xs">
                      selected
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
                <div className={cn('mt-0.5 text-xs capitalize', stateTone)}>{stateLabel}</div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SetupTile = {
  icon: LucideIcon | IconMynauiType | IconType;
  title: string;
  desc: string;
  count: number | null;
  section: CustomizeSection;
};

/** The "set up your project" entries shown as the quiet pill row. */
function useProjectSetupTiles(projectId: string): SetupTile[] {
  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    ...Q,
  });
  const connectors = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    ...Q,
  });
  const triggers = useQuery({
    queryKey: ['project-triggers', projectId],
    queryFn: () => listProjectTriggers(projectId),
    ...Q,
  });
  const access = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    ...Q,
  });

  const memberCount = access.data?.members.length ?? 0;

  return [
    {
      icon: HiOutlineViewGrid,
      title: 'Integrations',
      desc: 'Connect tools your agent can act in.',
      count: connectors.data?.connectors.length ?? 0,
      section: 'connectors',
    },
    {
      icon: CalendarClock,
      title: 'Scheduled tasks',
      desc: 'Run work on a schedule or from an event.',
      count: triggers.data?.triggers.length ?? 0,
      section: 'schedules',
    },
    {
      icon: SparklesSolid,
      title: 'Skills',
      desc: 'Repeatable workflows your agent reuses.',
      count: detail.data?.config?.skills.length ?? 0,
      section: 'skills',
    },
    {
      icon: Icon.Slack,
      title: 'Slack',
      desc: 'Run this project right from chat.',
      count: null,
      section: 'channels',
    },
    {
      icon: UsersGroupSolid,
      title: 'Your team',
      desc: 'Invite people to run and review work.',
      count: memberCount > 1 ? memberCount : 0,
      section: 'members',
    },
    {
      icon: Icon.Kortix,
      title: 'Agent',
      desc: 'Shape how your agent thinks and acts.',
      count: null,
      section: 'agents',
    },
  ];
}

function ProjectHomeSections({ projectId }: { projectId: string }) {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const tiles = useProjectSetupTiles(projectId);

  return (
    <div className="flex w-full max-w-3xl flex-wrap items-center justify-center gap-2">
      {tiles.map((tile) => {
        const { icon: TileIcon, title, desc, count, section } = tile;
        const isSet = (count ?? 0) > 0;

        return (
          <Hint key={section} label={desc} side="top">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openCustomize(section)}
              className="bg-background/60 gap-1.5 rounded-md backdrop-blur-sm"
            >
              <TileIcon className="text-muted-foreground size-4.5 shrink-0" />
              {title}
              {isSet ? (
                <span className="text-muted-foreground text-sm tabular-nums">{count}</span>
              ) : null}
            </Button>
          </Hint>
        );
      })}
    </div>
  );
}
