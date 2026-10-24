'use client';

import { useProjectConfig } from '@kortix/sdk/react';
import { isMetaAgentName } from '@kortix/shared';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../components/agent-mark';
import { CountBadge } from '../../primitives/count-badge';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '../../primitives/sidebar';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { projectAdminHref } from '../../workspace/admin/project-admin-sections';
import { useIsMobile } from '../hooks';
import { activeCapabilityTab, agentHref, capabilityTabHref } from '../lib/capability-tab-routes';
import { useReviewSessionSummary } from '../hooks/use-review-session-summary';
import { useCapabilityAccess } from './project-settings-nav';

type Agent = NonNullable<ReturnType<typeof useProjectConfig>>['agents'][number];

/** My Kortix first (the agent a person talks to), then every other agent by
 *  display name. */
export function sortCustomizeAgents<T extends Pick<Agent, 'name'>>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => {
    const meta = Number(isMetaAgentName(b.name)) - Number(isMetaAgentName(a.name));
    return meta || agentDisplayName(a.name).localeCompare(agentDisplayName(b.name));
  });
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


/**
 * The points nested under Customize. Customize is agent-first: My Kortix
 * leads (the one agent a person talks to, marked Built-in), then every other
 * agent by display name, each opening its own page — where its Access and
 * Runtime live. Then Review (with its "needs you" count) and Settings, which
 * opens Project admin on its General section: the project-wide libraries and
 * every project setting. The active row follows the pathname.
 */
export function ProjectCapabilityNav({ projectId }: { projectId: string }) {
  const pathname = useUiPathname();
  const config = useProjectConfig(projectId);
  const access = useCapabilityAccess(projectId);
  const needsYou = useReviewSessionSummary(projectId, { enabled: true }).totalNeedsYou;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const t = useI18nTranslations('agentEditor.page');

  if (!access.settled) return null;

  const agents = sortCustomizeAgents((config?.agents ?? []).filter((agent) => !agent.hidden));
  const activeAgent = decodeSegment(pathname?.match(/\/customize\/agents\/([^/?#]+)/)?.[1]);
  const hasReview = access.tabs.includes('review');
  const onReview = pathname ? activeCapabilityTab(pathname) === 'review' : false;
  const hasSettings = access.tabs.includes('config');
  const onSettings = pathname?.startsWith(`/projects/${projectId}/admin`) ?? false;
  const close = () => isMobile && setOpenMobile(false);

  if (agents.length === 0 && !hasReview && !hasSettings) return null;

  return (
    <SidebarMenuSub>
      {agents.map((agent) => (
        <SidebarMenuSubItem key={agent.name}>
          <SidebarMenuSubButton
            asChild
            isActive={activeAgent === agent.name}
          >
            <Link href={agentHref(projectId, agent.name)} prefetch={false} onClick={close}>
              <AgentMark slug={agent.name} size={14} />
              <span className="truncate">{agentDisplayName(agent.name)}</span>
              {agent.platform ? (
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">{t('builtIn')}</span>
              ) : null}
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
      {hasReview ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onReview}>
            <Link href={capabilityTabHref(projectId, 'review')} prefetch={false} onClick={close}>
              <span className="truncate">Review</span>
              {needsYou > 0 ? (
                <span className="ml-auto flex shrink-0 items-center">
                  <CountBadge count={needsYou} tone="waiting" />
                </span>
              ) : null}
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {hasSettings ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onSettings}>
            <Link href={projectAdminHref(projectId, 'general')} prefetch={false} onClick={close}>
              <span className="truncate">Settings</span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </SidebarMenuSub>
  );
}
