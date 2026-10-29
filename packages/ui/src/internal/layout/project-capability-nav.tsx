'use client';

import { adminPath } from '../../lib/routes';

import { useProjectAccountId, useProjectConfig } from '@kortix/sdk/react';

import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  CpuIcon,
  GearSixIcon,
  ListBulletsIcon,
  PlusIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { HubLink } from '../account-hub/account-hub-location';
import { agentDisplayName } from '../components/agent-mark';
import { Slot } from '@radix-ui/react-slot';
import { CountBadge } from '../../primitives/count-badge';
import { MENU_LABEL, menuRow } from '../../primitives/menu-recipe';
import { cn } from '../../lib/utils';
import { NavHoverCardList } from './nav-hover-card';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '../../primitives/sidebar';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { useIsMobile } from '../hooks';
import { activeCapabilityTab, capabilityTabHref } from '../lib/capability-tab-routes';
import { useReviewSessionSummary } from '../hooks/use-review-session-summary';
import { PROJECT_ACTIONS } from '../lib/project-actions';
import { useProjectCan } from '../lib/use-project-can';
import { hubTarget } from '../stores/account-panel-store';
import { useCapabilityAccess } from './project-settings-nav';
import { CreateAgentModal } from '../../customize/agents/create-agent-modal';

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
 * One Customize row: a sidebar sub-row, or a menu row inside the Customize
 * hover card. The child is the link; this gives it the row's classes.
 */
function CapabilityRow({ card, active = false, children }: { card: boolean; active?: boolean; children: ReactNode }) {
  if (card) {
    return (
      <li>
        <Slot className={menuRow('sm', 'default', cn('cursor-pointer', active && 'bg-accent'))}>{children}</Slot>
      </li>
    );
  }
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        {children}
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/**
 * The points under Customize: All agents (the index, with the count), New
 * agent (the create modal), Review (with its "needs you" count), Members (the
 * account hub's project access, for anyone who may read members), Models and
 * Settings (Project admin). The agents themselves are the sidebar's Agents
 * section (`project-agents-section.tsx`). The active row follows the pathname.
 *
 * `card` draws the same rows as the Customize hover card's list; `onNavigate`
 * closes that card.
 */
export function ProjectCapabilityNav({
  projectId,
  card = false,
  onNavigate,
}: {
  projectId: string;
  card?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = useUiPathname();
  const config = useProjectConfig(projectId);
  const access = useCapabilityAccess(projectId);
  const accountId = useProjectAccountId(projectId);
  const needsYou = useReviewSessionSummary(projectId, { enabled: true }).totalNeedsYou;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const canCreate = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const canReadMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ, { accountId }).allowed === true;
  const openNewAgent = useContext(NewAgentContext);

  if (!access.settled) return null;

  // My Kortix is not listed: the project home starts it, it has no page here.
  const allAgents = sortCustomizeAgents((config?.agents ?? []).filter((agent) => !agent.platform));

  const agentsIndex = capabilityTabHref(projectId, 'agent');
  const onIndex = !!pathname && /\/customize\/agents\/?$/.test(pathname);
  const hasAgents = access.tabs.includes('agent');
  const hasReview = access.tabs.includes('review');
  const onReview = pathname ? activeCapabilityTab(pathname) === 'review' : false;
  const hasSettings = access.tabs.includes('config');
  // Models is the one Project admin section people open often enough to keep
  // a row of its own here; Settings opens the rest.
  const hasModels = access.tabs.includes('models');
  const onModels = !!pathname && /\/admin\/models(\/|$)/.test(pathname);
  const onSettings = isProjectAdminPath(pathname) && !onModels;
  const showMembers = canReadMembers && !!accountId;
  const close = () => {
    onNavigate?.();
    if (isMobile) setOpenMobile(false);
  };

  if (allAgents.length === 0 && !hasReview && !hasSettings && !showMembers) return null;

  const List = card ? NavHoverCardList : SidebarMenuSub;
  return (
    <List>
      {hasAgents ? (
        <CapabilityRow card={card} active={onIndex}>
            <Link href={agentsIndex} prefetch={false} onClick={close}>
              <RowGlyph>
                <ListBulletsIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('allAgents')}</span>
              {allAgents.length > 0 ? (
                <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                  {allAgents.length}
                </span>
              ) : null}
            </Link>
          </CapabilityRow>
      ) : null}
      {canCreate ? (
        <CapabilityRow card={card}>
            {/* The href (`?new=1`) stays for a modified click and a copied link. */}
            <Link
              href={`${agentsIndex}?new=1`}
              prefetch={false}
              onClick={(e) => {
                // Without the provider the link goes to `?new=1`, where the Agents page opens it.
                if (!openNewAgent || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                close();
                openNewAgent();
              }}
            >
              <RowGlyph>
                <PlusIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('newAgent')}</span>
            </Link>
          </CapabilityRow>
      ) : null}
      {hasReview ? (
        <CapabilityRow card={card} active={onReview}>
            <Link href={capabilityTabHref(projectId, 'review')} prefetch={false} onClick={close}>
              <RowGlyph>
                <CheckCircleIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('review')}</span>
              {needsYou > 0 ? (
                <span className="ml-auto flex shrink-0 items-center">
                  <CountBadge count={needsYou} tone="waiting" />
                </span>
              ) : null}
            </Link>
          </CapabilityRow>
      ) : null}
      {showMembers && accountId ? (
        <CapabilityRow card={card}>
            <HubLink to={hubTarget(accountId, { tab: 'access-projects', project: projectId })} onClick={close}>
              <RowGlyph>
                <UsersIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tI18nComplete.raw('text1044a4c056d0')}</span>
              <ArrowUpRightIcon aria-hidden className="text-muted-foreground ml-auto size-3 shrink-0" />
            </HubLink>
          </CapabilityRow>
      ) : null}
      {hasModels ? (
        <CapabilityRow card={card} active={onModels}>
            <Link href={adminPath(projectId, 'models')} prefetch={false} onClick={close}>
              <RowGlyph>
                <CpuIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('models')}</span>
            </Link>
          </CapabilityRow>
      ) : null}
      {hasSettings ? (
        <CapabilityRow card={card} active={onSettings}>
            <Link href={adminPath(projectId, 'general')} prefetch={false} onClick={close}>
              <RowGlyph>
                <GearSixIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('settings')}</span>
            </Link>
          </CapabilityRow>
      ) : null}
    </List>
  );
}
