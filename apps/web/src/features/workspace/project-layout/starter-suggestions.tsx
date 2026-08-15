'use client';

import {
  CalendarDotsIcon as CalendarClock,
  SparkleIcon as SparklesSolid,
  SquaresFourIcon as HiOutlineViewGrid,
  UsersThreeIcon as UsersGroupSolid,
} from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import type { ComponentType } from 'react';

import { Kortix } from '@/features/icon/icons/kortix';
import { Slack } from '@/features/icon/icons/slack';
import {
  CAPABILITY_TABS,
  capabilityTabHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { cn } from '@/lib/utils';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import type { StarterSuggestionAction, StarterSuggestionsResponse } from '@kortix/sdk';
import { useProjectStarterSuggestions } from '@kortix/sdk/react';
import { STARTER_PROMPT_FALLBACKS } from '@kortix/shared';

import { visibleSuggestions } from './starter-suggestions-logic';

const MAX_VISIBLE = 5;

type SuggestionItem = StarterSuggestionsResponse['items'][number];

const FALLBACK_POOL: SuggestionItem[] = STARTER_PROMPT_FALLBACKS.map(({ id, label, prompt }) => ({
  id,
  label,
  prompt,
}));

/** Same routing an action row navigates to is used by the setup tiles at the
 *  bottom of project-home — see `PROJECT_SETUP_TILES` there. Connectors,
 *  Skills, and Agent graduated into their own routed pages; Schedules,
 *  Members, and Channels stay inside the settings overlay. */
const isCapabilityTabKey = (
  action: StarterSuggestionAction,
): action is CapabilityTab['key'] => CAPABILITY_TABS.some((tab) => tab.key === action);

/** Small muted leading icon per action — the same icon `PROJECT_SETUP_TILES`
 *  uses for the matching section. Prompt rows carry no icon at all. */
const ACTION_ICONS: Record<StarterSuggestionAction, ComponentType<{ className?: string }>> = {
  connectors: HiOutlineViewGrid,
  schedules: CalendarClock,
  skills: SparklesSolid,
  channels: Slack,
  members: UsersGroupSolid,
  agent: Kortix,
};

/**
 * Starter-suggestion rows shown under the hero composer — quiet, icon-free
 * text rows keyed to `item.label` (the row face), never the full prompt.
 * A row without an `action` prefills the composer with `item.prompt`; a row
 * with an `action` navigates to the matching capability page or settings
 * tab instead, with a small muted leading icon to mark it as a destination
 * rather than a prompt. Always the first 5 items of the pool — no shuffle.
 * One visual system for both the personalized and static states: while
 * loading or on error this renders the same static fallback texts the
 * server would otherwise send, so there is no flash, no spinner, and no
 * layout shift when the personalized set lands.
 */
export function StarterSuggestions({
  projectId,
  onPick,
}: {
  projectId: string;
  onPick: (text: string) => void;
}) {
  const router = useRouter();
  const openSettings = useSettingsPanelStore((s) => s.openSettings);
  const { data } = useProjectStarterSuggestions(projectId);
  const pool: SuggestionItem[] = data?.items ?? FALLBACK_POOL;
  const items = visibleSuggestions(pool, MAX_VISIBLE);

  if (items.length === 0) return null;

  const handlePick = (item: SuggestionItem) => {
    if (!item.action) {
      onPick(item.prompt);
      return;
    }
    if (isCapabilityTabKey(item.action)) {
      router.push(capabilityTabHref(projectId, item.action));
      return;
    }
    openSettings(item.action);
  };

  return (
    <div className="flex w-full flex-col items-center gap-1 px-4">
      {items.map((item) => {
        const Icon = item.action ? ACTION_ICONS[item.action] : null;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => handlePick(item)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left',
              'hover:bg-muted/60 transition-colors duration-150 active:scale-[0.99]',
            )}
          >
            {Icon ? <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden /> : null}
            <span className="text-foreground/90 line-clamp-1 text-sm leading-snug">
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
