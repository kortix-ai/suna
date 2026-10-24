'use client';

import { useProjectConfig } from '@kortix/sdk/react';

import { AgentMark } from '../components/agent-mark';
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
import { useCapabilityAccess } from './project-settings-nav';

/**
 * The points nested under Customize. Customize is 100% agent-centric (Marko,
 * 2026-10-24): the sidebar lists every agent with its own mark, and each row
 * opens that agent's config page — where its Access (Skills, Connectors,
 * Secrets, Apps, Drives, Kortix permissions) and Runtime (Model, Tools,
 * Workspace) live. The capability libraries are configured per agent there, or
 * managed globally under `/admin`. Repo and Review are no longer rows here —
 * they moved into Settings — so the only non-agent row is Settings, which also
 * carries the Review "needs you" count. The active row follows the pathname.
 */
export function ProjectCapabilityNav({ projectId }: { projectId: string }) {
  const pathname = useUiPathname();
  const config = useProjectConfig(projectId);
  const access = useCapabilityAccess(projectId);
  const needsYou = useReviewSessionSummary(projectId, { enabled: true }).totalNeedsYou;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  if (!access.settled) return null;

  const agents = (config?.agents ?? []).filter((agent) => !agent.hidden);
  const activeAgent = pathname?.match(/\/customize\/agents\/([^/?#]+)/)?.[1] ?? null;
  const hasSettings = access.tabs.includes('config');
  const onSettings = pathname ? activeCapabilityTab(pathname) === 'config' : false;
  const close = () => isMobile && setOpenMobile(false);

  if (agents.length === 0 && !hasSettings) return null;

  return (
    <SidebarMenuSub>
      {agents.map((agent) => (
        <SidebarMenuSubItem key={agent.name}>
          <SidebarMenuSubButton asChild isActive={activeAgent === agent.name}>
            <Link href={agentHref(projectId, agent.name)} prefetch={false} onClick={close}>
              <AgentMark slug={agent.name} size={14} />
              <span className="truncate">{agent.name}</span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
      {hasSettings ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onSettings}>
            <Link href={capabilityTabHref(projectId, 'config')} prefetch={false} onClick={close}>
              <span className="truncate">Settings</span>
              {needsYou > 0 ? (
                <span className="ml-auto flex shrink-0 items-center">
                  <CountBadge count={needsYou} tone="waiting" />
                </span>
              ) : null}
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </SidebarMenuSub>
  );
}
