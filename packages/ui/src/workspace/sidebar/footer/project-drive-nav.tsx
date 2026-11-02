'use client';

import type { Drive, DriveEntry } from '@kortix/sdk';
import { useDriveFolder } from '@kortix/sdk/react';
import { FolderSimpleIcon, HashIcon, ShareNetworkIcon, UsersIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { drivePathFromParam, drivePathToParam } from '../../../files/drives/drive-path-param';
import { useTranslations } from '../../../i18n';
import { useIsMobile } from '../../../internal/hooks';
import { Home } from '../../../internal/icons/home';
import { uiRoutes } from '../../../lib/routes';
import { CountBadge } from '../../../primitives/count-badge';
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, useSidebar } from '../../../primitives/sidebar';
import { UiLink as Link, useUiSearchParams } from '../../../providers/ui-provider';

const USERS_DIR = '/Users';
const CHANNELS_DIR = '/Channels';

const isUnder = (path: string, root: string) => root === '/' ? path === '/' : path === root || path.startsWith(`${root}/`);
const nameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/**
 * The Drive's places under the sidebar's Drive row, while a Drive page is
 * open: My files, what others shared with you, the team folders, the private
 * channels' folders you may open and, for admins, People (every person's own
 * folder). One sidebar: the Drive page has no rail of its own.
 */
export function ProjectDriveNav({ projectId, drive }: { projectId: string; drive: Drive }) {
  const t = useTranslations('drives');
  const href = uiRoutes().drive(projectId);
  const params = useUiSearchParams();
  const root = useDriveFolder(drive.driveId, '/');
  const isAdmin = drive.access === 'manage';
  const dirs = (root.data?.entries ?? []).filter((e) => e.type === 'dir');
  const team = dirs.filter((e) => e.access !== 'none' && e.path !== USERS_DIR && e.path !== CHANNELS_DIR);
  const hasChannels = dirs.some((e) => e.path === CHANNELS_DIR);
  const shared = (drive.sharedWithMe ?? []).filter((f) => !team.some((d) => d.path === f.path));
  if (!href) return null;

  const current = drivePathFromParam(params.get('path'), drive.personalFolder);
  const here = current === '/' ? '/' : `/${current}`;
  const to = (path: string) => {
    const param = drivePathToParam(path, drive.personalFolder);
    return param ? `${href}?path=${param}` : href;
  };
  const personal = drive.personalFolder;

  return (
    <SidebarMenuSub className="mr-0 pr-0">
      {personal ? (
        <PlaceItem href={to(personal)} active={isUnder(here, personal)} icon={<Home className="size-3.5" />} label={t('myDrive')} />
      ) : null}
      {shared.length > 0 ? (
        <>
          <GroupLabel>{t('sharedWithMe')}</GroupLabel>
          {shared.map((f) => (
            <PlaceItem
              key={f.path}
              href={to(f.path)}
              active={isUnder(here, f.path)}
              icon={<ShareNetworkIcon className="size-3.5" />}
              label={nameOf(f.path)}
            />
          ))}
        </>
      ) : null}
      {team.length > 0 ? (
        <>
          <GroupLabel>{t('teamFolders')}</GroupLabel>
          {team.map((e) => (
            <PlaceItem key={e.path} href={to(e.path)} active={isUnder(here, e.path)} icon={<FolderSimpleIcon className="size-3.5" />} label={e.name} />
          ))}
        </>
      ) : null}
      {hasChannels ? <ChannelItems driveId={drive.driveId} here={here} to={to} /> : null}
      {isAdmin ? <PeopleItem driveId={drive.driveId} personal={personal} href={to(USERS_DIR)} active={isUnder(here, USERS_DIR) && !(personal && isUnder(here, personal))} /> : null}
    </SidebarMenuSub>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <li role="presentation" className="text-muted-foreground truncate px-2 pt-2 pb-0.5 text-xs">
      {children}
    </li>
  );
}

function PlaceItem({
  href,
  active,
  icon,
  label,
  trailing,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        <Link href={href} prefetch={false} onClick={() => isMobile && setOpenMobile(false)}>
          <span aria-hidden className="text-muted-foreground flex size-5 shrink-0 items-center justify-center">
            {icon}
          </span>
          <span className="truncate">{label}</span>
          {trailing ? <span className="ml-auto flex shrink-0 items-center">{trailing}</span> : null}
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/** The private channels' folders the caller may open. */
function ChannelItems({ driveId, here, to }: { driveId: string; here: string; to: (path: string) => string }) {
  const t = useTranslations('drives');
  const list = useDriveFolder(driveId, CHANNELS_DIR);
  const channels = (list.data?.entries ?? []).filter((e: DriveEntry) => e.type === 'dir' && e.access !== 'none');
  if (channels.length === 0) return null;
  return (
    <>
      <GroupLabel>{t('overview.channels')}</GroupLabel>
      {channels.map((e: DriveEntry) => (
        <PlaceItem
          key={e.path}
          href={to(e.path)}
          active={isUnder(here, e.path)}
          icon={<HashIcon className="size-3.5" />}
          label={e.name.replace(/^#/, '')}
        />
      ))}
    </>
  );
}

/** Admins: one row for every person's own folder, with how many there are. */
function PeopleItem({ driveId, personal, href, active }: { driveId: string; personal: string | null; href: string; active: boolean }) {
  const t = useTranslations('drives');
  const list = useDriveFolder(driveId, USERS_DIR);
  const count = (list.data?.entries ?? []).filter((e: DriveEntry) => e.type === 'dir' && e.path !== personal).length;
  return (
    <>
      <GroupLabel>{t('overview.admin')}</GroupLabel>
      <PlaceItem
        href={href}
        active={active}
        icon={<UsersIcon className="size-3.5" />}
        label={t('overview.people')}
        trailing={count > 0 ? <CountBadge count={count} tone="neutral" /> : null}
      />
    </>
  );
}
