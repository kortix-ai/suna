'use client';

import { CountBadge } from '../../primitives/count-badge';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '../../primitives/sidebar';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { useIsMobile } from '../hooks';
import {
  activeCapabilityTab,
  capabilityTabHref,
  CAPABILITY_TABS,
  type CapabilityTab,
} from '../lib/capability-tab-routes';
import { useReviewSessionSummary } from '../hooks/use-review-session-summary';
import { useCapabilityAccess } from './project-settings-nav';

const CAPABILITY_LABEL: Record<CapabilityTab['key'], string> = Object.fromEntries(
  CAPABILITY_TABS.map((tab) => [tab.key, tab.label]),
) as Record<CapabilityTab['key'], string>;

/**
 * The capability points nested under Customize — one text row per point the
 * caller may open (Agents, Skills, Connectors, Triggers, Reminders, Models,
 * Secrets, Repo, Review, Settings), in bar order, gated by the same
 * `capabilityAccess` rule the tab bar uses. Text only, no glyphs: a column of
 * mixed 16px icons reads as clutter, the same reason the tab bar is text only
 * (Marko, 2026-08-19). Each links to its capability page, which scopes to the
 * active domain on its own; the active row follows the pathname.
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
