'use client';

import type { ReactNode } from 'react';

import {
  BellIcon,
  CpuIcon,
  GearSixIcon,
  GitBranchIcon,
  KeyIcon,
  LightningIcon,
  PlugIcon,
  SealCheckIcon,
  SparkleIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';

import { CountBadge } from '../../primitives/count-badge';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '../../primitives/sidebar';
import { UiLink as Link } from '../../providers/ui-provider';
import { useUiPathname } from '../../providers/ui-provider';
import { useIsMobile } from '../hooks';
import {
  activeCapabilityTab,
  capabilityTabHref,
  CAPABILITY_TABS,
  type CapabilityTab,
} from '../lib/capability-tab-routes';
import { useReviewSessionSummary } from '../hooks/use-review-session-summary';
import { useCapabilityAccess } from './project-settings-nav';

/** One glyph per capability point. The tab-routes module stays icon-free (it is
 *  imported by server components); the icons live here in the client row. */
const CAPABILITY_ICON: Record<CapabilityTab['key'], ReactNode> = {
  agent: <UsersThreeIcon />,
  skills: <SparkleIcon />,
  connectors: <PlugIcon />,
  triggers: <LightningIcon />,
  reminders: <BellIcon />,
  models: <CpuIcon />,
  secrets: <KeyIcon />,
  files: <GitBranchIcon />,
  review: <SealCheckIcon />,
  config: <GearSixIcon />,
};

const CAPABILITY_LABEL: Record<CapabilityTab['key'], string> = Object.fromEntries(
  CAPABILITY_TABS.map((tab) => [tab.key, tab.label]),
) as Record<CapabilityTab['key'], string>;

/**
 * The capability points nested under Customize — one sub-row per point the
 * caller may open (Agents, Skills, Connectors, Triggers, Reminders, Models,
 * Secrets, Repo, Review, Settings), in bar order, gated by the same
 * `capabilityAccess` rule the tab bar uses. Each links to its capability page,
 * which scopes to the active domain on its own (`active-domain-store`); the
 * active sub-row follows the pathname, so browsing one agent or a connector
 * keeps its point lit.
 */
export function ProjectCapabilityNav({ projectId }: { projectId: string }) {
  const pathname = useUiPathname();
  const access = useCapabilityAccess(projectId);
  const activeKey = pathname ? activeCapabilityTab(pathname) : null;
  const needsYou = useReviewSessionSummary(projectId, { enabled: true }).totalNeedsYou;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  if (!access.settled || access.tabs.length === 0) return null;

  return (
    <SidebarMenuSub>
      {access.tabs.map((key) => (
        <SidebarMenuSubItem key={key}>
          <SidebarMenuSubButton asChild isActive={activeKey === key}>
            <Link
              href={capabilityTabHref(projectId, key)}
              prefetch={false}
              onClick={() => isMobile && setOpenMobile(false)}
            >
              <span className="shrink-0">{CAPABILITY_ICON[key]}</span>
              <span className="truncate">{CAPABILITY_LABEL[key]}</span>
              {key === 'review' && needsYou > 0 ? (
                <span className="ml-auto flex shrink-0 items-center">
                  <CountBadge count={needsYou} tone="waiting" />
                </span>
              ) : null}
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );
}
