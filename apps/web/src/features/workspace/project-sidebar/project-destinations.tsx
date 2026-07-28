'use client';

/**
 * The destination rows above the session list: Files, All sessions, Projects.
 *
 * These are places you go, as opposed to the Customize group below them, which
 * is configuration. Claude keeps the same split (New / Chats and tasks /
 * Projects / … then Customize), and it is what stops the sidebar reading as one
 * long undifferentiated list.
 *
 * Shared with the signed-out homepage, which routes every row to the sign-in
 * gate instead of a project. One component, so the two cannot drift.
 */

import { FolderOpen, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';

export type DestinationKey = 'sessions' | 'files';

export interface Destination {
  key: DestinationKey;
  label: string;
  icon: typeof FolderOpen;
}

export const PROJECT_DESTINATIONS: readonly Destination[] = [
  { key: 'sessions', label: 'All sessions', icon: MessagesSquare },
  { key: 'files', label: 'Files', icon: FolderOpen },
];

// No "Projects" row yet. The multi-project manager it would open does not
// exist, and a destination that goes nowhere is worse than an absent one.

const ROW_CLASS = 'flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!';

export function ProjectDestinationsGroup({
  hrefFor,
  isActive,
  onSelect,
  onNavigate,
}: {
  hrefFor?: (key: DestinationKey) => string;
  isActive?: (key: DestinationKey) => boolean;
  /** Used instead of a link when the surface has nowhere to navigate yet. */
  onSelect?: (key: DestinationKey) => void;
  onNavigate?: () => void;
}) {
  return (
    <SidebarGroup className="py-0">
      <SidebarMenu>
        {PROJECT_DESTINATIONS.map(({ key, label, icon: Icon }) => {
          const href = hrefFor?.(key);
          return (
            <SidebarMenuItem key={key}>
              <SidebarMenuButton
                asChild={!!href}
                isActive={isActive?.(key)}
                tooltip={label}
                className={ROW_CLASS}
                onClick={
                  href
                    ? undefined
                    : () => {
                        onSelect?.(key);
                        onNavigate?.();
                      }
                }
              >
                {href ? (
                  <Link href={href} onClick={onNavigate}>
                    <Icon />
                    {label}
                  </Link>
                ) : (
                  <>
                    <Icon />
                    {label}
                  </>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/** Signed-in wiring: real routes, active state from the pathname. */
export function ProjectDestinations({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  const hrefFor = (key: DestinationKey) => `/projects/${projectId}/${key}`;

  return (
    <ProjectDestinationsGroup
      hrefFor={hrefFor}
      isActive={(key) => !!pathname?.startsWith(`/projects/${projectId}/${key}`)}
      onNavigate={() => {
        if (isMobile) setOpenMobile(false);
      }}
    />
  );
}
