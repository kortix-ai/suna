'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { PlusIcon } from '@phosphor-icons/react';

import { DRIVE_KIND_ICON } from './drive-icons';
import { type DriveRecord, groupDrives, projectAccessOf } from './drive-model';

interface DriveListProps {
  drives: DriveRecord[];
  selectedDriveId: string | null;
  onSelect: (driveId: string) => void;
  onCreate: (kind: 'personal' | 'company') => void;
  /** Only an account owner or admin can create a company drive. */
  canCreateCompany: boolean;
}

/** The drive rail: My drives, Shared with me, Company drives, Agent drives. */
export function DriveList({
  drives,
  selectedDriveId,
  onSelect,
  onCreate,
  canCreateCompany,
}: DriveListProps) {
  const t = useTranslations('drives');
  const groups = groupDrives(drives);

  return (
    <nav aria-label={t('title')} className="space-y-5 px-2 py-3">
      <DriveGroup
        label={t('myDrives')}
        action={{ label: t('newPersonalDrive'), onClick: () => onCreate('personal') }}
      >
        {groups.personal.map((drive) => (
          <DriveRow
            key={drive.driveId}
            drive={drive}
            selected={drive.driveId === selectedDriveId}
            onSelect={onSelect}
            meta={drive.isDefault ? t('defaultDrive') : undefined}
          />
        ))}
      </DriveGroup>

      {groups.shared.length ? (
        <DriveGroup label={t('sharedWithMe')}>
          {groups.shared.map((drive) => (
            <DriveRow
              key={drive.driveId}
              drive={drive}
              selected={drive.driveId === selectedDriveId}
              onSelect={onSelect}
              meta={drive.ownerEmail?.split('@')[0] ?? undefined}
            />
          ))}
        </DriveGroup>
      ) : null}

      <DriveGroup
        label={t('companyDrives')}
        action={
          canCreateCompany
            ? { label: t('newCompanyDrive'), onClick: () => onCreate('company') }
            : undefined
        }
        empty={groups.company.length === 0 ? t('noCompanyDrives') : undefined}
      >
        {groups.company.map((drive) => (
          <DriveRow
            key={drive.driveId}
            drive={drive}
            selected={drive.driveId === selectedDriveId}
            onSelect={onSelect}
            meta={projectAccessOf(drive) ? t('inThisProject') : undefined}
          />
        ))}
      </DriveGroup>

      <DriveGroup
        label={t('agentDrives')}
        empty={groups.agent.length === 0 ? t('noAgentDrives') : undefined}
      >
        {groups.agent.map((drive) => (
          <DriveRow
            key={drive.driveId}
            drive={drive}
            selected={drive.driveId === selectedDriveId}
            onSelect={onSelect}
          />
        ))}
      </DriveGroup>
    </nav>
  );
}

function DriveGroup({
  label,
  action,
  empty,
  children,
}: {
  label: string;
  action?: { label: string; onClick: () => void };
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1">
      <div className="flex h-7 items-center justify-between gap-2 pl-2">
        <h2 className="text-muted-foreground text-xs font-medium">{label}</h2>
        {action ? (
          <Hint label={action.label} side="right">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={action.label}
              onClick={action.onClick}
              className="text-muted-foreground hover:text-foreground"
            >
              <PlusIcon className="size-3.5 shrink-0" />
            </Button>
          </Hint>
        ) : null}
      </div>
      {empty ? (
        <p className="text-muted-foreground px-2 text-xs text-pretty">{empty}</p>
      ) : (
        <ul className="space-y-0.5">{children}</ul>
      )}
    </section>
  );
}

function DriveRow({
  drive,
  selected,
  onSelect,
  meta,
}: {
  drive: DriveRecord;
  selected: boolean;
  onSelect: (driveId: string) => void;
  meta?: string;
}) {
  const t = useTranslations('drives');
  const KindIcon = DRIVE_KIND_ICON[drive.kind];
  return (
    <li>
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={() => onSelect(drive.driveId)}
        className={cn(
          'focus-visible:ring-ring flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2',
          selected ? 'bg-active text-foreground font-medium' : 'text-foreground hover:bg-hover',
        )}
      >
        <KindIcon
          className={cn('size-4 shrink-0', selected ? 'text-foreground' : 'text-muted-foreground')}
        />
        <span className="min-w-0 flex-1 truncate">{drive.name}</span>
        {drive.openConflicts ? (
          <span
            className="text-kortix-orange shrink-0 text-xs font-medium tabular-nums"
            aria-label={t('conflictCount', { count: drive.openConflicts })}
          >
            {drive.openConflicts}
          </span>
        ) : meta ? (
          <span className="text-muted-foreground shrink-0 text-xs font-normal">{meta}</span>
        ) : null}
      </button>
    </li>
  );
}

export function DriveListSkeleton() {
  return (
    <div className="space-y-5 px-2 py-3" aria-hidden>
      {[2, 1, 2].map((rows, group) => (
        <div key={group} className="space-y-1">
          <Skeleton className="mx-2 my-1.5 h-4 w-24 rounded-sm" />
          {Array.from({ length: rows }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-full rounded-md" />
          ))}
        </div>
      ))}
    </div>
  );
}
