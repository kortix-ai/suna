'use client';

import { useProjectSpaces, useVisibleAgents } from '@kortix/sdk/react';
import { CaretRightIcon, HashIcon, PlusIcon } from '@phosphor-icons/react';
import { useMemo, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { ProjectNavRow } from '../../internal/layout/project-nav-row';
import { cn } from '../../internal/lib/utils';
import {
  selectCollapsedSections,
  useSessionFilterStore,
} from '../../internal/stores/session-filter-store';
import { customizePath, uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import Hint from '../../primitives/hint';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '../../primitives/sidebar';
import { useUiPathname, useUiRouter } from '../../providers/ui-provider';
import { CreateChannelDialog } from '../spaces/create-channel-dialog';
import { agentLabel } from '../spaces/space-timeline';

/** Collapse state lives in the persisted session-filter store, beside the session sections. */
const CHANNELS_SECTION_ID = 'section:channels';
const DMS_SECTION_ID = 'section:dms';

/** `href`, or a page under it. */
function isAt(pathname: string | null, href: string): boolean {
  return !!pathname && (pathname === href || pathname.startsWith(`${href}/`));
}

/**
 * The sidebar under the `project_channels` flag: Channels, then Direct
 * messages, in the slot the session list holds with the flag off. A section
 * renders once its data arrives: no skeleton rows for navigation.
 */
export function ProjectSpacesNav({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const router = useUiRouter();
  const spaces = useProjectSpaces(projectId);
  const agents = useVisibleAgents({ projectId });
  const [createOpen, setCreateOpen] = useState(false);
  const collapsedSections = useSessionFilterStore(selectCollapsedSections(projectId));
  const collapsed = useMemo(() => new Set(collapsedSections), [collapsedSections]);
  const toggleSectionCollapsed = useSessionFilterStore((s) => s.toggleSectionCollapsed);

  const channels = spaces.data?.filter((space) => space.kind === 'channel' && !space.archived_at);

  return (
    <FadedScrollArea fadeColor="from-background" className="h-full min-h-0 space-y-2">
      {spaces.isError && !spaces.data ? (
        <div className="space-y-1.5 px-2 py-2">
          <p className="text-destructive/80 text-xs">{t('spaces.loadError')}</p>
          <Button variant="outline" size="xs" onClick={() => spaces.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {channels ? (
        <SpacesSection
          title={t('spaces.channels')}
          open={!collapsed.has(CHANNELS_SECTION_ID)}
          onToggle={() => toggleSectionCollapsed(projectId, CHANNELS_SECTION_ID)}
          action={{ label: t('spaces.addChannel'), onClick: () => setCreateOpen(true) }}
        >
          {channels.map((channel) => {
            const href = uiRoutes().channel(projectId, channel.slug ?? '');
            return (
              <ProjectNavRow
                key={channel.space_id}
                href={href}
                active={isAt(pathname, href)}
                label={`#${channel.slug}`}
              >
                <HashIcon />
                <span>{channel.slug}</span>
              </ProjectNavRow>
            );
          })}
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setCreateOpen(true)} className="text-muted-foreground hover:text-sidebar-foreground">
              <PlusIcon />
              <span>{t('spaces.addChannel')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SpacesSection>
      ) : null}
      {/* Waits for the channels: drawn first, the agents jumped down when the channels arrived. */}
      {spaces.data && agents.length > 0 ? (
        <SpacesSection
          title={t('spaces.directMessages')}
          open={!collapsed.has(DMS_SECTION_ID)}
          onToggle={() => toggleSectionCollapsed(projectId, DMS_SECTION_ID)}
          // Every visible agent already has a DM row: the `+` makes a new agent.
          action={{ label: t('spaces.newAgent'), onClick: () => router.push(customizePath(projectId, 'agents')) }}
        >
          {agents.map((agent) => {
            const name = agentLabel(agent.name);
            const href = uiRoutes().dm(projectId, agent.name);
            return (
              <ProjectNavRow
                key={agent.name}
                href={href}
                active={isAt(pathname, href)}
                label={name}
                // The row forces every svg to size-4: the pixel mark keeps its 14px glyph.
                className="[&_[data-slot=agent-mark]>svg]:size-[14px]!"
              >
                <AgentMark slug={agent.name} size={14} />
                <span>{name}</span>
              </ProjectNavRow>
            );
          })}
        </SpacesSection>
      ) : null}
      <CreateChannelDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />
    </FadedScrollArea>
  );
}

/**
 * A collapsible section: the muted label, then the caret, then a `+` at the
 * trailing edge. The caret and the `+` stay hidden until the header is hovered
 * or focused, so the list reads as names, not chrome. A collapsed section keeps
 * its caret, so a closed section still says it holds more.
 *
 * The `+` is a sibling of the trigger, not inside it: a button nested in a
 * `role="button"` is invalid, and its click would also toggle the section.
 */
function SpacesSection({
  title,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** The header's `+`: its label (tooltip and accessible name) and what it does. */
  action: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <Disclosure
      open={open}
      onOpenChange={onToggle}
      className="group/section"
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div className="group/section-header flex h-8 items-center gap-1 pr-1">
        <DisclosureTrigger>
          <div
            className={cn(
              'text-muted-foreground hover:text-sidebar-foreground flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md px-2 text-sm font-medium',
              'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none',
            )}
          >
            <span className="truncate">{title}</span>
            <CaretRightIcon
              aria-hidden
              className={cn(
                'duration-normal size-3 shrink-0 transition-[rotate,opacity] ease-out',
                'opacity-0 group-focus-within/section-header:opacity-100 group-hover/section-header:opacity-100',
                'group-data-[state=closed]/section:opacity-100 group-data-[state=open]/section:rotate-90',
              )}
            />
          </div>
        </DisclosureTrigger>
        <Hint label={action.label} side="right">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={action.label}
            onClick={action.onClick}
            className="text-muted-foreground hover:text-sidebar-foreground shrink-0 opacity-0 group-focus-within/section-header:opacity-100 group-hover/section-header:opacity-100 focus-visible:opacity-100"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </Hint>
      </div>
      <DisclosureContent contentClassName="pt-px">
        <SidebarMenu className="gap-px">{children}</SidebarMenu>
      </DisclosureContent>
    </Disclosure>
  );
}
