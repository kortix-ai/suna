'use client';

import { useProjectSpaces, useVisibleAgents } from '@kortix/sdk/react';
import { CaretRightIcon, HashIcon, PlusIcon, RobotIcon } from '@phosphor-icons/react';
import { useMemo, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { ProjectNavRow } from '../../internal/layout/project-nav-row';
import { cn } from '../../internal/lib/utils';
import {
  selectCollapsedSections,
  useSessionFilterStore,
} from '../../internal/stores/session-filter-store';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '../../primitives/sidebar';
import { useUiPathname } from '../../providers/ui-provider';
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
            <SidebarMenuButton onClick={() => setCreateOpen(true)}>
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
                // The row forces every svg to size-4; the xs tile draws its glyph at size-3.
                className="[&_[data-slot=entity-avatar]>svg]:size-3!"
              >
                <EntityAvatar icon={RobotIcon} label={name} size="xs" />
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

/** A collapsible section: caret, then the muted label, then its rows. */
function SpacesSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Disclosure
      open={open}
      onOpenChange={onToggle}
      className="group/section"
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <DisclosureTrigger>
        <div
          className={cn(
            'text-muted-foreground hover:text-sidebar-foreground flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm',
            'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none',
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <CaretRightIcon
              aria-hidden
              className="duration-normal size-3 transition-transform ease-out group-data-[state=open]/section:rotate-90"
            />
          </span>
          <span className="truncate">{title}</span>
        </div>
      </DisclosureTrigger>
      <DisclosureContent contentClassName="pt-px">
        <SidebarMenu className="gap-px">{children}</SidebarMenu>
      </DisclosureContent>
    </Disclosure>
  );
}
