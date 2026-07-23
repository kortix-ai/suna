'use client';

import { Icon as IconMynauiType, SparklesSolid, UsersGroupSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  CalendarClock,
  Check,
  Container,
  FileCode,
  GitBranch,
  Package,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { IconType } from 'react-icons/lib';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandItem,
  CommandItemHoverCard,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import Hint from '@/components/ui/hint';
import { Icon } from '@/features/icon/icon';
import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import { COMPOSER_PILL_TRIGGER_CLASS } from '@/features/session/composer-pill';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { SessionWelcome } from '@/features/session/session-welcome';
import type { Command } from '@/hooks/runtime/use-runtime-sessions';
import type { CustomizeSection } from '@/lib/customize-sections';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';
import { cn } from '@/lib/utils';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  getProjectDetail,
  listProjectAccessRequests,
  listProjectBranches,
  listProjectSandboxes,
  type SandboxTemplate,
} from '@kortix/sdk/projects-client';
import { chalkColors } from '@kortix/shared';
import { HiOutlineViewGrid } from 'react-icons/hi';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export interface ProjectHomeSendOptions extends ComposerOptions {
  sandbox_slug?: string;
  base_ref?: string;
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
  const [selectedBaseRef, setSelectedBaseRef] = useState<string | null>(null);
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
  const branchesQuery = useQuery({
    queryKey: ['project-branches', projectId],
    queryFn: () => listProjectBranches(projectId),
    ...Q,
  });
  // NOTE: this worktree's `/projects/:id/branches` response only carries
  // `default_branch` + `branches[]` — main's group-scoped
  // `session_default_ref`/`session_default_source`/`session_default_conflict`
  // fields don't exist on `ProjectBranchesResponse` here (see
  // `packages/sdk/src/core/rest/projects-client/git-history.ts`). Falls back
  // to the plain repo default; the group-default distinction + conflict
  // banner are follow-up work once that backend field lands.
  const effectiveBaseRef = branchesQuery.data?.default_branch ?? null;
  const activeBaseRef = selectedBaseRef ?? effectiveBaseRef;
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
        // null means "inherit the server's current group/project default".
        // Only a deliberate picker choice becomes a per-session override.
        base_ref: selectedBaseRef ?? undefined,
      });
    },
    [activeSlug, selectedBaseRef, onSend],
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
            // `busy` here means "create in flight" — spinner in the send slot,
            // input locked. NOT isBusy (that renders agent-running stop-button
            // semantics, which leave the composer with no button at all here).
            isSending={busy}
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
              showSandboxPicker || activeBaseRef ? (
                <div className="flex items-center gap-1">
                  {activeBaseRef ? (
                    <BranchPicker
                      response={branchesQuery.data}
                      activeRef={activeBaseRef}
                      onSelect={(ref) => setSelectedBaseRef(ref === effectiveBaseRef ? null : ref)}
                    />
                  ) : null}
                  {showSandboxPicker ? (
                    <SandboxPicker
                      items={sandboxItems}
                      activeSlug={activeSlug}
                      onSelect={setSelectedSlug}
                    />
                  ) : null}
                </div>
              ) : null
            }
          />
        }
      />
    </div>
  );
}

export function BranchPicker({
  response,
  activeRef,
  onSelect,
}: {
  response: Awaited<ReturnType<typeof listProjectBranches>> | undefined;
  activeRef: string;
  onSelect: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const branchNames = Array.from(
    new Set(
      [response?.default_branch, ...(response?.branches.map((branch) => branch.name) ?? [])].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );

  return (
    <CommandPopover open={open} onOpenChange={setOpen}>
      <Hint
        side="top"
        className="max-w-[260px] text-xs"
        label="Start this session from a branch — its work still lands on its own session branch"
      >
        <CommandPopoverTrigger>
          <button
            type="button"
            aria-label={`Session branch: ${activeRef}`}
            data-testid="branch-picker"
            className={cn(COMPOSER_PILL_TRIGGER_CLASS, 'max-w-44')}
          >
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{activeRef.slice(0, 8)}</span>
          </button>
        </CommandPopoverTrigger>
      </Hint>
      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[260px]">
        <CommandList className="max-h-[280px]">
          <CommandGroup forceMount>
            {branchNames.map((ref) => {
              const isSelected = ref === activeRef;
              const isDefault = ref === response?.default_branch;
              return (
                <CommandItem
                  key={ref}
                  value={`branch-${ref}`}
                  data-testid="branch-option"
                  data-branch={ref}
                  className={cn('gap-2', isSelected && 'bg-primary/[0.06]')}
                  onSelect={() => {
                    onSelect(ref);
                    setOpen(false);
                  }}
                >
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate font-mono text-sm leading-tight',
                      isSelected ? 'text-foreground font-semibold' : 'text-foreground/90',
                    )}
                  >
                    {ref.slice(0, 8)}
                  </span>
                  {isDefault ? (
                    <span className="text-muted-foreground/60 shrink-0 text-xs">default</span>
                  ) : null}
                  {isSelected && <Check className="text-foreground size-4 shrink-0" />}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
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
        <ProjectHomeSections />
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

/** Dot color + hover-card copy per sandbox build state — the dot carries the
 *  live state on the one-line row; the words live in the hover card. */
function sandboxStatePresentation(state: SandboxTemplate['daytona_state']): {
  dot: string;
  label: string;
} {
  if (state === 'active') return { dot: 'bg-kortix-green', label: 'Ready' };
  if (state === 'pulling' || state === 'building')
    return { dot: 'bg-kortix-blue', label: 'Building — session will wait' };
  if (state === 'missing')
    return { dot: 'bg-muted-foreground/40', label: 'Not built — first session will build it' };
  return { dot: 'bg-kortix-red', label: state.replace('_', ' ') };
}

export function SandboxPicker({
  items,
  activeSlug,
  onSelect,
}: {
  items: SandboxTemplate[];
  activeSlug: string;
  onSelect: (slug: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const active = items.find((t) => t.slug === activeSlug) ?? items[0] ?? null;
  if (!active) return null;
  const ActiveIcon = active.is_default ? Container : active.has_image ? Package : FileCode;
  return (
    <CommandPopover open={open} onOpenChange={setOpen}>
      <Hint
        side="top"
        className="max-w-[260px] text-xs"
        label="Choose the sandbox this session runs in"
      >
        <CommandPopoverTrigger>
          <button
            type="button"
            aria-label={tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrAria4acf4ecd',
            )}
            data-testid="sandbox-picker"
            className={COMPOSER_PILL_TRIGGER_CLASS}
          >
            <ActiveIcon className="size-3.5 shrink-0" />
            <span className="max-w-[7rem] truncate">{active.name}</span>
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                sandboxStatePresentation(active.daytona_state).dot,
              )}
            />
          </button>
        </CommandPopoverTrigger>
      </Hint>
      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[260px]">
        <CommandList className="max-h-[280px]">
          <CommandGroup forceMount>
            {items.map((tpl) => {
              const isSelected = tpl.slug === activeSlug;
              const state = sandboxStatePresentation(tpl.daytona_state);
              const subtitle = tpl.is_default
                ? 'Platform default · clones workspace at boot'
                : tpl.has_image
                  ? `Image: ${tpl.image}`
                  : `Dockerfile: ${tpl.dockerfile_path}`;
              return (
                <CommandItemHoverCard
                  key={tpl.template_id ?? `tpl-${tpl.slug}`}
                  content={
                    <div data-testid="sandbox-hover-card">
                      <p className="text-sm font-medium">{tpl.name}</p>
                      <p className="text-muted-foreground mt-1 text-xs leading-snug text-pretty">
                        {subtitle}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs leading-snug">
                        {state.label}
                      </p>
                    </div>
                  }
                >
                  <CommandItem
                    value={`sandbox-${tpl.slug}`}
                    data-testid="sandbox-option"
                    data-sandbox={tpl.slug}
                    className={cn('gap-2', isSelected && 'bg-primary/[0.06]')}
                    onSelect={() => {
                      onSelect(tpl.slug);
                      setOpen(false);
                    }}
                  >
                    <span className={cn('size-1.5 shrink-0 rounded-full', state.dot)} />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm leading-tight',
                        isSelected
                          ? 'text-foreground font-semibold'
                          : 'text-foreground/90 font-medium',
                      )}
                    >
                      {tpl.name}
                    </span>
                    {isSelected && <Check className="text-foreground size-4 shrink-0" />}
                  </CommandItem>
                </CommandItemHoverCard>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}

type SetupTile = {
  icon: LucideIcon | IconMynauiType | IconType;
  title: string;
  desc: string;
  section: CustomizeSection;
};

/** Static navigation does not fetch counts before the user opens Customize. */
const PROJECT_SETUP_TILES: SetupTile[] = [
  {
    icon: HiOutlineViewGrid,
    title: 'Integrations',
    desc: 'Connect tools your agent can act in.',
    section: 'connectors',
  },
  {
    icon: CalendarClock,
    title: 'Scheduled tasks',
    desc: 'Run work on a schedule or from an event.',
    section: 'schedules',
  },
  {
    icon: SparklesSolid,
    title: 'Skills',
    desc: 'Repeatable workflows your agent reuses.',
    section: 'skills',
  },
  {
    icon: Icon.Slack,
    title: 'Slack',
    desc: 'Run this project right from chat.',
    section: 'channels',
  },
  {
    icon: UsersGroupSolid,
    title: 'Your team',
    desc: 'Invite people to run and review work.',
    section: 'members',
  },
  {
    icon: Icon.Kortix,
    title: 'Agent',
    desc: 'Shape how your agent thinks and acts.',
    section: 'agents',
  },
];

function ProjectHomeSections() {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const tiles = PROJECT_SETUP_TILES;

  return (
    <div className="flex w-full max-w-3xl flex-wrap items-center justify-center gap-2">
      {tiles.map((tile) => {
        const { icon: TileIcon, title, desc, section } = tile;

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
            </Button>
          </Hint>
        );
      })}
    </div>
  );
}
