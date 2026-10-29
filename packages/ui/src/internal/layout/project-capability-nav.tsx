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
import { AgentMark, agentDisplayName } from '../components/agent-mark';
import { CountBadge } from '../../primitives/count-badge';
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
import { PROJECT_ACTIONS } from '../lib/project-actions';
import { useProjectCan } from '../lib/use-project-can';
import { hubTarget } from '../stores/account-panel-store';
import { useCapabilityAccess } from './project-settings-nav';
import { CreateAgentModal } from '../../customize/agents/create-agent-modal';

type Agent = NonNullable<ReturnType<typeof useProjectConfig>>['agents'][number];

const NewAgentContext = createContext<(() => void) | null>(null);

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

/** The agent segment of the pathname, decoded like the agent page decodes it. */
function decodeSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** More agents than this collapse behind the All agents row, so the group
 *  never pushes Sessions below the fold. */
const MAX_LISTED_AGENTS = 5;

/** A utility row's glyph, in the same 20px box as an agent's mark (literal px
 *  for the same reason as `AgentMark`), so every label starts on one column. */
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
 * The points nested under Customize. Customize is agent-first: My Kortix
 * leads (the one agent a person talks to, marked Built-in), then every other
 * agent by display name (a hidden agent muted, last), each opening its own
 * page, where its Access and Runtime live. Then the utility rows, each with a
 * glyph in the agent mark's box: All agents (the index, always present, with
 * the count), New agent (the index's create modal), Review (with its "needs
 * you" count), Members (the account hub's project access, for anyone who may
 * read members) and Settings (Project admin). Customize has no top bar: this
 * group is its whole navigation. The active row follows the pathname; a
 * missing agent lights no row.
 */
export function ProjectCapabilityNav({ projectId }: { projectId: string }) {
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
  const activeName = decodeSegment(pathname?.match(/\/customize\/agents\/([^/?#]+)/)?.[1]);
  // The first agents, plus the open one when it falls past the cut.
  const listed = allAgents.slice(0, MAX_LISTED_AGENTS);
  const open = allAgents.find((agent) => agent.name === activeName);
  const agents = open && !listed.includes(open) ? [...listed, open] : listed;

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
  const close = () => isMobile && setOpenMobile(false);

  if (allAgents.length === 0 && !hasReview && !hasSettings && !showMembers) return null;

  return (
    <SidebarMenuSub>
      {agents.map((agent) => (
        <SidebarMenuSubItem key={agent.name}>
          <SidebarMenuSubButton asChild isActive={activeName === agent.name}>
            <Link href={agentHref(projectId, agent.name)} prefetch={false} onClick={close}>
              <AgentMark slug={agent.name} size={14} />
              <span className={agent.hidden ? 'text-muted-foreground truncate' : 'truncate'}>
                {agentDisplayName(agent.name)}
              </span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
      {hasAgents ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onIndex}>
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
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {canCreate ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild>
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
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {hasReview ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onReview}>
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
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {showMembers && accountId ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild>
            <HubLink to={hubTarget(accountId, { tab: 'access-projects', project: projectId })} onClick={close}>
              <RowGlyph>
                <UsersIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tI18nComplete.raw('text1044a4c056d0')}</span>
              <ArrowUpRightIcon aria-hidden className="text-muted-foreground ml-auto size-3 shrink-0" />
            </HubLink>
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
          <SidebarMenuSubButton asChild isActive={onSettings}>
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
