'use client';

import type { Drive, DriveEntry } from '@kortix/sdk';
import { Label } from '@kortix/ui/label';
import { Skeleton } from '@kortix/ui/skeleton';
import { DriveStorageSummary, useDriveFolder, useFolderAccess } from '@kortix/ui/files';
import { Home } from '@kortix/ui/internal/icons/home';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { FolderSimpleIcon, HashIcon, LockSimpleIcon, UserIcon, UsersThreeIcon } from '@phosphor-icons/react';
import type { ComponentType, ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';

import { folderAudience } from './folder-audience';

/** The folder of one person, one private channel, or the private channels: never a team folder. */
const USERS_DIR = '/Users';
const CHANNELS_DIR = '/Channels';

/** Where sessions see a folder of the Drive: the same path, under /drives. */
export function boxPathOf(path: string, personal: string | null): string {
  if (personal && (path === personal || path.startsWith(`${personal}/`))) return `~/Desktop${path.slice(personal.length)}`;
  return `/drives${path}`;
}

/** Platinum reports seconds or milliseconds; the age reads the same either way. */
function entryAge(mtime: number | undefined, locale: string): string {
  if (!mtime) return '';
  return relativeTime(mtime < 1e12 ? mtime * 1000 : mtime, locale);
}

const nameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/**
 * The top of the Drive: one block per kind of place, so the one tree reads as
 * what it is. Yours (your own folder, your desktop in sessions), what others
 * shared with you, the team folders and who can open each, the private
 * channels' folders, and for admins every person's own folder.
 */
export function DriveOverview({
  drive,
  locale,
  onOpen,
}: {
  drive: Drive;
  locale: string;
  onOpen: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const root = useDriveFolder(drive.driveId, '/');
  const isAdmin = drive.access === 'manage';
  const entries = root.data?.entries ?? [];
  const dirs = entries.filter((e) => e.type === 'dir');
  const team = dirs.filter((e) => e.access !== 'none' && e.path !== USERS_DIR && e.path !== CHANNELS_DIR);
  const hasChannels = dirs.some((e) => e.path === CHANNELS_DIR);
  const shared = (drive.sharedWithMe ?? []).filter((f) => !team.some((d) => f.path === d.path));
  const personal = drive.personalFolder;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 lg:py-10">
      <DriveStorageSummary driveId={drive.driveId} />

      {personal ? (
        <Section label={t('overview.yours')}>
          <PlaceRow
            icon={Home}
            name={t('myDrive')}
            audience={isAdmin ? t('overview.audienceYouAndAdmins') : t('overview.audienceYou')}
            where={boxPathOf(personal, personal)}
            onClick={() => onOpen(personal)}
          />
        </Section>
      ) : null}

      {shared.length > 0 ? (
        <Section label={t('sharedWithMe')}>
          {shared.map((f) => (
            <PlaceRow
              key={f.path}
              icon={FolderSimpleIcon}
              name={nameOf(f.path)}
              audience={t('overview.sharedWithYou')}
              where={boxPathOf(f.path, personal)}
              onClick={() => onOpen(f.path)}
            />
          ))}
        </Section>
      ) : null}

      <Section label={t('teamFolders')}>
        {root.isLoading ? (
          <RowSkeletons />
        ) : team.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('noTeamFolders')}</p>
        ) : (
          team.map((e) => <TeamFolderRow key={e.path} drive={drive} entry={e} locale={locale} onOpen={onOpen} />)
        )}
      </Section>

      {hasChannels ? <ChannelsSection drive={drive} locale={locale} onOpen={onOpen} /> : null}

      {isAdmin ? <PeopleSection drive={drive} locale={locale} onOpen={onOpen} /> : null}
    </div>
  );
}

function Section({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <Label>{label}</Label>
        {note ? <p className="text-muted-foreground text-xs text-pretty">{note}</p> : null}
      </div>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

function RowSkeletons() {
  return (
    <>
      <Skeleton className="h-14 w-full rounded-md" />
      <Skeleton className="h-14 w-full rounded-md" />
    </>
  );
}

/** One place in the Drive: what it is, who can open it, where sessions see it, its age. */
function PlaceRow({
  icon: Glyph,
  name,
  audience,
  where,
  age,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  name: string;
  audience?: ReactNode;
  where?: string;
  age?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="bg-background border-border hover:bg-accent/60 duration-fast flex w-full min-w-0 items-center gap-3 rounded-md border px-4 py-2.5 text-left transition-colors"
      >
        <Glyph className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="text-foreground block truncate text-sm font-medium">{name}</span>
          {audience || where ? (
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              {audience ? <span className="flex shrink-0 items-center gap-1">{audience}</span> : null}
              {audience && where ? <span className="text-muted-foreground/40">&bull;</span> : null}
              {where ? <span className="truncate font-mono">{where}</span> : null}
            </span>
          ) : null}
        </span>
        {age ? <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{age}</span> : null}
      </button>
    </li>
  );
}

/** A team folder and who can open it: everyone, admins only, or how many people. */
function TeamFolderRow({
  drive,
  entry,
  locale,
  onOpen,
}: {
  drive: Drive;
  entry: DriveEntry;
  locale: string;
  onOpen: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const access = useFolderAccess(drive.driveId, entry.path);
  const audience = access.data ? folderAudience(access.data.grants) : null;
  const label =
    audience?.mode === 'everyone' ? (
      t('everyoneInProject')
    ) : audience?.mode === 'specific' ? (
      t('badgePeople', { count: audience.named.length })
    ) : audience?.mode === 'restricted' ? (
      <>
        <LockSimpleIcon className="size-3" />
        {t('audienceAdmins')}
      </>
    ) : undefined;
  return (
    <PlaceRow
      icon={audience?.mode === 'everyone' ? UsersThreeIcon : FolderSimpleIcon}
      name={entry.name}
      audience={label}
      where={boxPathOf(entry.path, drive.personalFolder)}
      age={entryAge(entry.mtime, locale)}
      onClick={() => onOpen(entry.path)}
    />
  );
}

/** The private channels' folders the caller may open: each channel's members, and its threads. */
function ChannelsSection({ drive, locale, onOpen }: { drive: Drive; locale: string; onOpen: (path: string) => void }) {
  const t = useTranslations('drives');
  const list = useDriveFolder(drive.driveId, CHANNELS_DIR);
  const channels = (list.data?.entries ?? []).filter((e) => e.type === 'dir' && e.access !== 'none');
  if (!list.isLoading && channels.length === 0) return null;
  return (
    <Section label={t('overview.channels')} note={t('overview.channelsNote')}>
      {list.isLoading ? (
        <RowSkeletons />
      ) : (
        channels.map((e) => (
          <PlaceRow
            key={e.path}
            icon={HashIcon}
            name={e.name.replace(/^#/, '')}
            audience={t('overview.channelMembers')}
            where={boxPathOf(e.path, drive.personalFolder)}
            age={entryAge(e.mtime, locale)}
            onClick={() => onOpen(e.path)}
          />
        ))
      )}
    </Section>
  );
}

/** Admins: every person's own folder. Each open is recorded, and its owner sees it. */
function PeopleSection({ drive, locale, onOpen }: { drive: Drive; locale: string; onOpen: (path: string) => void }) {
  const t = useTranslations('drives');
  const list = useDriveFolder(drive.driveId, USERS_DIR);
  const people = (list.data?.entries ?? []).filter((e) => e.type === 'dir' && e.path !== drive.personalFolder);
  return (
    <Section label={t('overview.people')} note={t('overview.peopleNote')}>
      {list.isLoading ? (
        <RowSkeletons />
      ) : people.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('overview.noPeople')}</p>
      ) : (
        people.map((e) => (
          <PlaceRow
            key={e.path}
            icon={UserIcon}
            name={e.name}
            audience={
              <>
                <LockSimpleIcon className="size-3" />
                {t('overview.audienceOwnerAndAdmins')}
              </>
            }
            age={entryAge(e.mtime, locale)}
            onClick={() => onOpen(e.path)}
          />
        ))
      )}
    </Section>
  );
}
