'use client';

/**
 * The sidebar's Agents section, above Sessions and built like it: the label is
 * the trigger of a disclosure (a caret on hover, the sidebar row's rounded
 * hover fill), and its right edge holds one secondary button group: + (New
 * agent) joined to ⋯ (All agents). Under it, each agent the project declares, by its mark and
 * name, opening its page. My Kortix is not listed: the project home starts it.
 * Open by default; the choice persists in the sessions' collapse store.
 */

import { useProjectConfig } from '@kortix/sdk/react';
import { CaretRightIcon, DotsThreeIcon, PlusIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { useIsMobile } from '../../internal/hooks';
import { sortCustomizeAgents, useOpenNewAgent } from '../../internal/layout/project-capability-nav';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { agentHref, capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import {
  selectCollapsedSections,
  useSessionFilterStore,
} from '../../internal/stores/session-filter-store';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import Hint from '../../primitives/hint';
import { useSidebar } from '../../primitives/sidebar';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { SESSION_ROW_HEIGHT_CLASS } from './session-list-chrome';

const AGENTS_SECTION_ID = 'section:agents';

export function ProjectAgentsSection({ projectId }: { projectId: string }) {
  const tTabs = useTranslations('agentEditor.tabs');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = useUiPathname();
  const config = useProjectConfig(projectId);
  const access = useCapabilityAccess(projectId);
  const canCreate = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const openNewAgent = useOpenNewAgent();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const collapsed = useSessionFilterStore(selectCollapsedSections(projectId));
  const toggleSectionCollapsed = useSessionFilterStore((s) => s.toggleSectionCollapsed);

  if (!access.settled || !access.tabs.includes('agent')) return null;
  const agents = sortCustomizeAgents((config?.agents ?? []).filter((agent) => !agent.platform));
  const agentsIndex = capabilityTabHref(projectId, 'agent');
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Disclosure
      open={!collapsed.includes(AGENTS_SECTION_ID)}
      onOpenChange={() => toggleSectionCollapsed(projectId, AGENTS_SECTION_ID)}
      className="group/agents shrink-0 space-y-px pb-2"
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div
        className={cn(
          'group/agents-header hover:bg-sidebar-row flex w-full shrink-0 flex-row items-center gap-1 rounded-md px-2 transition-colors',
          SESSION_ROW_HEIGHT_CLASS,
        )}
      >
        <DisclosureTrigger>
          <div className="text-muted-foreground group-hover/agents-header:text-sidebar-foreground flex min-w-0 flex-1 cursor-pointer flex-row items-center gap-1 self-stretch text-sm font-medium focus-visible:outline-none">
            <span className="truncate">{tI18nComplete.raw('text279b44d2ab4b')}</span>
            <CaretRightIcon
              aria-hidden
              className="duration-normal size-3 shrink-0 opacity-0 transition-transform ease-out group-hover/agents-header:opacity-100 group-data-[state=open]/agents:rotate-90"
            />
          </div>
        </DisclosureTrigger>
        <ButtonGroup className="shrink-0">
          {canCreate && openNewAgent ? (
            <Hint side="top" label={tTabs('newAgent')}>
              <Button
                variant="secondary"
                size="icon-xs"
                type="button"
                aria-label={tTabs('newAgent')}
                onClick={() => {
                  close();
                  openNewAgent();
                }}
              >
                <PlusIcon className="size-4" />
              </Button>
            </Hint>
          ) : null}
          <Hint side="top" label={tTabs('allAgents')}>
            <Button variant="secondary" size="icon-xs" asChild>
              <Link href={agentsIndex} prefetch={false} aria-label={tTabs('allAgents')} onClick={close}>
                <DotsThreeIcon className="size-4" />
              </Link>
            </Button>
          </Hint>
        </ButtonGroup>
      </div>
      <DisclosureContent contentClassName="space-y-px">
        {agents.map((agent) => {
          const href = agentHref(projectId, agent.name);
          const active = !!pathname && (pathname === href || pathname.startsWith(`${href}/`));
          return (
            <Link
              key={agent.name}
              href={href}
              prefetch={false}
              onClick={close}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 text-sm transition-colors',
                SESSION_ROW_HEIGHT_CLASS,
                active
                  ? 'bg-active text-sidebar-foreground font-medium'
                  : 'text-sidebar-foreground hover:bg-sidebar-row',
              )}
            >
              <AgentMark slug={agent.name} size={14} />
              <span className={cn('min-w-0 flex-1 truncate', agent.hidden && 'text-muted-foreground')}>
                {agentDisplayName(agent.name)}
              </span>
            </Link>
          );
        })}
      </DisclosureContent>
    </Disclosure>
  );
}
