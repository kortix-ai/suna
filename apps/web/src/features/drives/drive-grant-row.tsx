'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import { useSetDriveGrant } from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';

import { type DriveAccess, type DriveRecord, canManageDrive, projectAccessOf } from './drive-model';
import { driveMountPath } from './drive-mount';

/**
 * "Use in this project" for a company drive, with its access level. Everyone
 * sees the state; only a viewer who manages the drive can change it.
 */
export function DriveGrantRow({ drive, projectId }: { drive: DriveRecord; projectId: string }) {
  const t = useTranslations('drives');
  const setGrant = useSetDriveGrant();
  const access = projectAccessOf(drive);
  const mountPath = driveMountPath(drive);
  const canManage = canManageDrive(drive);

  const update = (next: DriveAccess | null) =>
    setGrant.mutate(
      { driveId: drive.driveId, projectId, access: next },
      { onError: () => errorToast(t('grantFailed')) },
    );

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
      <Switch
        checked={access !== null}
        disabled={!canManage || setGrant.isPending}
        onCheckedChange={(checked) => update(checked ? 'write' : null)}
        aria-label={t('grantTitle')}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('grantTitle')}</p>
        <p className="text-muted-foreground text-xs text-pretty">
          {access && mountPath
            ? t('grantDescription', { path: mountPath })
            : t('grantDescriptionOff')}
          {canManage ? null : ` ${t('grantAdminOnly')}`}
        </p>
      </div>
      {access ? (
        <Select
          value={access}
          disabled={!canManage || setGrant.isPending}
          onValueChange={(value) => update(value as DriveAccess)}
        >
          <SelectTrigger aria-label={t('accessLabel')} className="w-40 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="write">{t('accessWrite')}</SelectItem>
            <SelectItem value="read">{t('accessRead')}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
