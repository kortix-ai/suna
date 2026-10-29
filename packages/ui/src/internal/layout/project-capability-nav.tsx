'use client';

import { adminPath } from '../../lib/routes';

import { useProjectConfig } from '@kortix/sdk/react';

import { CpuIcon, GearSixIcon, ListIcon, TrayIcon } from '@phosphor-icons/react';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../components/agent-mark';
import { CountBadge } from '../../primitives/count-badge';
import { cn } from '../../lib/utils';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '../../primitives/sidebar';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { useIsMobile } from '../hooks';
import { activeCapabilityTab, agentHref, capabilityTabHref } from '../lib/capability-tab-routes';
import { useReviewSessionSummary } from '../hooks/use-review-session-summary';
import { usePinnedAgents } from '../stores/pinned-agents-store';
import { useCapabilityAccess } from './project-settings-nav';
import { CreateAgentModal } from '../../customize/agents/create-agent-modal';

/** Customize lists this many agents when none is pinned; All agents holds the rest. */
const SIDEBAR_AGENT_LIMIT = 5;

type Agent = NonNullable<ReturnType<typeof useProjectConfig>>['agents'][number];

const NewAgentContext = createContext<(() => void) | null>(null);

/** Opens the New agent modal mounted beside the sidebar; null outside `NewAgentModalProvider`. */
export function useOpenNewAgent(): (() => void) | null {
  return useContext(NewAgentContext);
}

/**
 * The sidebar's New agent opens the create modal in place, with no
 * navigation. The modal is mounted here, beside `<Sidebar>`, never inside it:
 * on mobile the sidebar is a sheet that unmounts its content when it closes,
 * and New agent closes it, so a modal inside it shut the moment it opened.
 * `null` until the first click, so the modal and its hooks mount only when used.
 */
export function NewAgentModalProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const config = useProjectConfig(projectId);
  const [open, setOpen] = useState<boolean | null>(null);
  const openModal = useCallback(() => setOpen(true), []);
  return (
    <NewAgentContext.Provider value={openModal}>
      {children}
      {open !== null ? (
        <CreateAgentModal open={open} onOpenChange={setOpen} projectId={projectId} config={config ?? null} />
      ) : null}
    </NewAgentContext.Provider>
  );
}

/** Every agent by display name, hidden agents last. */
export function sortCustomizeAgents<T extends Pick<Agent, 'name'> & { hidden?: boolean | null }>(
  agents: readonly T[],
): T[] {
  return [...agents].sort((a, b) => {
    const hidden = Number(a.hidden === true) - Number(b.hidden === true);
    return hidden || agentDisplayName(a.name).localeCompare(agentDisplayName(b.name));
  });
}

/** Whether the pathname is a Project admin (Settings) page. The locale prefix
 *  the host may not strip is tolerated. */
export function isProjectAdminPath(pathname: string | null | undefined): boolean {
  return !!pathname && /\/projects\/[^/]+\/admin(?:[/?#]|$)/.test(pathname);
}

/** A row's glyph in a 20px box (literal px, as the sidebar's agent marks), so
 *  every label starts on one column. */
function RowGlyph({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="text-muted-foreground flex shrink-0 items-center justify-center"
      style={{ width: 20, height: 20 }}
    >
      {children}
    </span>
  );
}

/**
 * What Customize opens to, kept short on purpose: most configuration happens
 * by asking an agent in a session, so the sidebar lists only the agents you
 * pinned (none pinned: the first five) and All agents when more exist, then Review (with its "needs you" count), Models, and Settings
 * (Project admin, whose top bar holds every library and Members).
 * The header's + and All agents buttons sit on the Customize row itself.
 */
export function ProjectCapabilityNav({ projectId }: { projectId: string }) {
  const pathname = useUiPathname();
  const config = useProjectConfig(projectId);
  const access = useCapabilityAccess(projectId);
  const needsYou = useReviewSessionSummary(projectId, { enabled: true }).totalNeedsYou;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const pinned = usePinnedAgents(projectId);

  if (!access.settled) return null;

  const allAgents = access.tabs.includes('agent')
    ? sortCustomizeAgents((config?.agents ?? []).filter((agent) => !agent.platform))
    : [];
  // The agents you pinned, in pin order; none pinned, the first few. A
  // project with a hundred agents keeps a short sidebar either way.
  const pinnedAgents = pinned.flatMap((name) => allAgents.filter((agent) => agent.name === name));
  const agents = pinnedAgents.length > 0 ? pinnedAgents : allAgents.slice(0, SIDEBAR_AGENT_LIMIT);
  const moreAgents = allAgents.length > agents.length;
  const showReview = access.tabs.includes('review');
  const onReview = pathname ? activeCapabilityTab(pathname) === 'review' : false;
  const hasModels = access.tabs.includes('models');
  const onModels = !!pathname && /\/admin\/models(\/|$)/.test(pathname);
  const hasSettings = access.tabs.includes('config');
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  if (agents.length === 0 && !showReview && !hasModels && !hasSettings) return null;

  // `mr-0 pr-0`: the rows reach the sidebar's right edge like the rows above;
  // the left indent and guide line stay.
  return (
    <SidebarMenuSub className="mr-0 pr-0">
      {agents.map((agent) => {
        const href = agentHref(projectId, agent.name);
        const active = !!pathname && (pathname === href || pathname.startsWith(`${href}/`));
        return (
          <SidebarMenuSubItem key={agent.name}>
            <SidebarMenuSubButton asChild isActive={active}>
              <Link href={href} prefetch={false} onClick={close}>
                <RowGlyph>
                  <AgentMark slug={agent.name} size={14} />
                </RowGlyph>
                <span className={cn('truncate', agent.hidden && 'text-muted-foreground')}>
                  {agentDisplayName(agent.name)}
                </span>
              </Link>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        );
      })}
      {moreAgents ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={!!pathname && pathname.endsWith('/customize/agents')}>
            <Link href={capabilityTabHref(projectId, 'agent')} prefetch={false} onClick={close}>
              <RowGlyph>
                <ListIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('allAgents')}</span>
              <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">{allAgents.length}</span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {showReview ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onReview}>
            <Link href={capabilityTabHref(projectId, 'review')} prefetch={false} onClick={close}>
              <RowGlyph>
                <TrayIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('review')}</span>
              {needsYou > 0 ? (
                <span className="ml-auto flex shrink-0 items-center">
                  <CountBadge count={needsYou} tone="waiting" />
                </span>
              ) : null}
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {hasModels ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onModels}>
            <Link href={adminPath(projectId, 'models')} prefetch={false} onClick={close}>
              <RowGlyph>
                <CpuIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('models')}</span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {hasSettings ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={isProjectAdminPath(pathname) && !onModels}>
            <Link href={adminPath(projectId, 'general')} prefetch={false} onClick={close}>
              <RowGlyph>
                <GearSixIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('settings')}</span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </SidebarMenuSub>
  );
}
