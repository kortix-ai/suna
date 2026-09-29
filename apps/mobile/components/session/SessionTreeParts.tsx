/**
 * SessionTreeParts — the pieces the drawer and the Sessions page share to show
 * a server-nested session list (KRTX-639):
 *
 * - `StarterLabel`: who started the run (`sessionStarter`): a glyph for an
 *   automated starter (schedule, webhook, channel, API key), the name for a
 *   member. No robot emoji.
 * - `ExpandControl`: the child count and a caret. It toggles a parent's
 *   children. Its own hit target, so a tap never opens the session.
 * - `SessionChildren`: one parent's children, loaded 20 at a time
 *   (`useSessionChildren`), with "Show more". Nothing loads while collapsed
 *   (the caller mounts it only for an expanded parent).
 *
 * Layout rules: apps/mobile/design.md → Project sidebar → Nesting and starters.
 */

import { PERSISTED_QUERY_GC_TIME_MS } from '@/lib/query/persisted-queries';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { haptics } from '@/lib/haptics';
import {
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  ClockIcon,
  EnvelopeIcon,
  KeyIcon,
  LightningIcon,
  SlackLogoIcon,
  WebhooksLogoIcon,
  type AppIcon,
} from '@/lib/icons';
import { useSessionChildren } from '@kortix/sdk/react/session-list';
import { sessionDisplayTitle, type SessionStarter, type SessionStarterIcon } from '@kortix/sdk';
import type { ProjectSession } from '@/lib/projects/projects-client';

/** The glyph of each SDK starter icon. Teams, Telegram and any other channel share the chat bubble. */
const STARTER_ICONS: Record<NonNullable<SessionStarterIcon>, AppIcon> = {
  schedule: ClockIcon,
  webhook: WebhooksLogoIcon,
  trigger: LightningIcon,
  slack: SlackLogoIcon,
  email: EnvelopeIcon,
  teams: ChatCircleIcon,
  telegram: ChatCircleIcon,
  channel: ChatCircleIcon,
  api: KeyIcon,
};

/** Rows a parent shows per "Show more". */
const SESSION_CHILDREN_PAGE_SIZE = 20;

/** One muted line: [glyph] label. */
export function StarterLabel({ starter }: { starter: SessionStarter }) {
  return (
    <View className="flex-row items-center gap-1" accessible accessibilityLabel={`Started by ${starter.label}`}>
      {starter.icon ? <Icon as={STARTER_ICONS[starter.icon]} size={12} className="text-muted-foreground" /> : null}
      <Text variant="muted" style={{ fontSize: 13, lineHeight: 17 }} numberOfLines={1} className="shrink">
        {starter.label}
      </Text>
    </View>
  );
}

/** The child count and a caret; tap toggles the parent's children. */
export function ExpandControl({
  count,
  expanded,
  onToggle,
  title,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** The parent's title, for the screen reader. */
  title: string;
}) {
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onToggle();
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${count} sub-agent ${count === 1 ? 'session' : 'sessions'} of ${title}`}
      accessibilityState={{ expanded }}
      className="flex-row items-center gap-1 rounded-sm px-1 py-0.5 active:bg-foreground/5">
      <Text className="text-xs text-muted-foreground" style={{ fontVariant: ['tabular-nums'] }}>
        {count > 99 ? '99+' : String(count)}
      </Text>
      <Icon as={expanded ? CaretDownIcon : CaretRightIcon} size={14} className="text-muted-foreground" />
    </Pressable>
  );
}

export interface SessionChildrenProps {
  projectId: string;
  parent: ProjectSession;
  /** The active search text: narrows the children to the ones it matched. */
  q?: string;
  /** Renders one child row. `trunkBelow` is true while a later row (or "Show more") follows. */
  renderChild: (child: ProjectSession, trunkBelow: boolean) => React.ReactNode;
  /** Left inset of "Show more", on the children's edge. */
  moreInset?: number;
  /** Loaders draw only while this surface is in front. */
  showLoader?: boolean;
}

export function SessionChildren({ projectId, parent, q, renderChild, moreInset = 0, showLoader = true }: SessionChildrenProps) {
  const query = useSessionChildren(projectId, parent.session_id, {
    q,
    limit: SESSION_CHILDREN_PAGE_SIZE,
    gcTime: PERSISTED_QUERY_GC_TIME_MS,
  });
  const { sessions, hasNextPage, isFetchingNextPage, isPending, isError, fetchNextPage, refetch } = query;

  if (isPending && !isError) {
    return (
      <View className="items-center py-2" accessibilityLabel="Loading sub-agent sessions">
        {showLoader ? <KortixLoader size="small" /> : null}
      </View>
    );
  }
  if (sessions.length === 0) {
    return isError ? (
      <View className="items-start px-4 py-1" style={{ marginLeft: moreInset }}>
        <Button variant="ghost" size="sm" onPress={() => void refetch()}>
          <Text>Couldn&apos;t load. Try again</Text>
        </Button>
      </View>
    ) : null;
  }
  return (
    <View>
      {sessions.map((child, index) =>
        renderChild(child, hasNextPage || index < sessions.length - 1)
      )}
      {hasNextPage ? (
        <View style={{ marginLeft: moreInset }} className="items-start px-2 py-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={isFetchingNextPage}
            onPress={() => {
              haptics.tap();
              void fetchNextPage();
            }}
            accessibilityLabel={`Show more sub-agent sessions of ${sessionDisplayTitle(parent)}`}>
            <Text>{isFetchingNextPage ? 'Loading…' : 'Show more'}</Text>
          </Button>
        </View>
      ) : null}
    </View>
  );
}
