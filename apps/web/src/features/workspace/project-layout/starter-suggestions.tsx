'use client';

import {
  CalendarDotsIcon as CalendarClock,
  SparkleIcon as SparklesSolid,
  SquaresFourIcon as HiOutlineViewGrid,
  UsersThreeIcon as UsersGroupSolid,
} from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState, type ComponentType } from 'react';

import { Kortix } from '@/features/icon/icons/kortix';
import { Slack } from '@/features/icon/icons/slack';
import {
  CAPABILITY_TABS,
  capabilityTabHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import type { StarterSuggestionAction, StarterSuggestionsResponse } from '@kortix/sdk';
import { useProjectStarterSuggestions } from '@kortix/sdk/react';
import { STARTER_PROMPT_FALLBACKS } from '@kortix/shared';

import {
  ConnectorSuggestionRow,
  StarterSuggestionConnectModal,
  SuggestionActionRow,
  type PendingConnectorApp,
} from './starter-suggestion-connect';
import { suggestionRowKind, visibleSuggestions } from './starter-suggestions-logic';

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
 *
 * Two exceptions to "navigates instead":
 * - a `connectors` item that carries a server-validated `connector` record,
 *   for a viewer who can write project connectors, renders as a
 *   connect-in-place row instead — see `suggestionRowKind` and
 *   `starter-suggestion-connect.tsx`. Anyone without that write access still
 *   gets the plain navigating row, same as a connectors item with no
 *   `connector` record.
 * - a `skills` item never navigates: it renders the same connect-in-place row
 *   shape (Sparkle icon + "Create skill" button) but both the row and the
 *   button prefill the composer with `item.prompt`, same as a plain prompt
 *   row — see `suggestionRowKind`.
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
  // Only probe IAM when a row could actually need it — most visible sets
  // carry no connectors item at all, and the probe is a network round trip.
  const hasConnectorItem = items.some(
    (item) => item.action === 'connectors' && item.connector != null,
  );
  const canConnect =
    useProjectCan(
      hasConnectorItem ? projectId : undefined,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    ).allowed === true;
  const [pendingApp, setPendingApp] = useState<PendingConnectorApp | null>(null);

  if (items.length === 0) return null;

  const navigateForAction = (action: StarterSuggestionAction) => {
    if (isCapabilityTabKey(action)) {
      router.push(capabilityTabHref(projectId, action));
      return;
    }
    openSettings(action);
  };

  const handlePick = (item: SuggestionItem) => {
    if (!item.action) {
      onPick(item.prompt);
      return;
    }
    const kind = suggestionRowKind(item, canConnect);
    if (kind === 'connector' && item.connector) {
      setPendingApp({
        slug: item.connector.slug,
        name: item.connector.name,
        imgSrc: item.connector.img_src,
      });
      return;
    }
    if (kind === 'skill') {
      onPick(item.prompt);
      return;
    }
    navigateForAction(item.action);
  };

  return (
    <div className="flex w-full flex-col items-center gap-1 px-4">
      {items.map((item) => {
        const kind = suggestionRowKind(item, canConnect);
        if (kind === 'connector' && item.connector) {
          return (
            <ConnectorSuggestionRow
              key={item.id}
              label={item.label}
              app={{
                slug: item.connector.slug,
                name: item.connector.name,
                imgSrc: item.connector.img_src,
              }}
              onConnect={() => handlePick(item)}
            />
          );
        }
        if (kind === 'skill') {
          return (
            <SuggestionActionRow
              key={item.id}
              label={item.label}
              icon={<SparklesSolid className="text-muted-foreground size-4" aria-hidden />}
              buttonLabel="Create skill"
              onAction={() => handlePick(item)}
            />
          );
        }
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
      <StarterSuggestionConnectModal
        projectId={projectId}
        pendingApp={pendingApp}
        onOpenChange={(open) => !open && setPendingApp(null)}
      />
    </div>
  );
}
