'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { ClockIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useMaintenanceAdmin,
  useUpdateMaintenanceConfig,
} from '@/hooks/admin/use-maintenance-admin';
import type { MaintenanceLevel } from '@/lib/maintenance-store';

import { AdminPageShell } from '../_components/admin-page-shell';
import { AdminPanel, AdminSection } from '../_components/admin-panel';
import {
  MAINTENANCE_LEVELS,
  MAINTENANCE_TONE_GLYPH,
  MaintenanceConfigModal,
  MaintenanceLevelRow,
} from './_components';

// Same output as `toLocaleString()` with no options: date + time, numeric fields.
const updatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

export default function AdminUtilsPage() {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const { data: config, isLoading } = useMaintenanceAdmin();
  const updateConfig = useUpdateMaintenanceConfig();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState<MaintenanceLevel>('none');

  // Form state
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [statusUrl, setStatusUrl] = useState('');
  const [services, setServices] = useState<string[]>([]);

  // Sync form state when config loads or changes.
  useEffect(() => {
    if (!config) return;
    setSelectedLevel(config.level);
    setTitle(config.title || '');
    setMessage(config.message || '');
    setStartDate(config.startTime ? new Date(config.startTime) : undefined);
    setEndDate(config.endTime ? new Date(config.endTime) : undefined);
    setStatusUrl(config.statusUrl || '');
    setServices(config.affectedServices || []);
  }, [config]);

  const handleLevelClick = (level: MaintenanceLevel) => {
    setSelectedLevel(level);

    // Pre-fill title from the level when it is empty or still holds the current
    // level's default label.
    if (!title || title === MAINTENANCE_LEVELS.find((l) => l.value === config?.level)?.label) {
      const levelDef = MAINTENANCE_LEVELS.find((l) => l.value === level);
      if (levelDef && level !== 'none') setTitle(levelDef.label);
    }

    setDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      if (selectedLevel === 'none') {
        await updateConfig.mutateAsync({
          level: 'none',
          title: '',
          message: '',
          startTime: null,
          endTime: null,
          statusUrl: null,
          affectedServices: [],
        });
        successToast(tI18nComplete.raw('text6af04bb05dd8'));
      } else {
        await updateConfig.mutateAsync({
          level: selectedLevel,
          title,
          message,
          startTime: startDate ? startDate.toISOString() : null,
          endTime: endDate ? endDate.toISOString() : null,
          statusUrl: statusUrl || null,
          affectedServices: services.length > 0 ? services : undefined,
        });
        const levelDef = MAINTENANCE_LEVELS.find((l) => l.value === selectedLevel);
        successToast(
          tI18nComplete('text50b7777e2015', {
            value0: levelDef?.label ?? tI18nComplete.raw('text17ccfa5b681e'),
          }),
        );
      }
      setDialogOpen(false);
    } catch (err) {
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('text54266bfe04ff'));
    }
  };

  const toggleService = (serviceLabel: string) => {
    setServices((prev) =>
      prev.includes(serviceLabel)
        ? prev.filter((s) => s !== serviceLabel)
        : [...prev, serviceLabel],
    );
  };

  const currentLevel = config?.level ?? 'none';
  const currentLevelDef = MAINTENANCE_LEVELS.find((l) => l.value === currentLevel);
  const isActive = currentLevel !== 'none';

  return (
    <AdminPageShell
      title={tI18nComplete.raw('text17ccfa5b681e')}
      description={tI18nComplete.raw('textec3e7d0c8967')}
      action={
        isActive && currentLevelDef ? (
          <Badge variant="outline" size="sm">
            {currentLevelDef.label} {tI18nComplete.raw('text96879611650f')}
          </Badge>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[62px] w-full rounded-md" />
          ))}
        </div>
      ) : (
        <>
          {isActive && config && currentLevelDef && (
            <AdminSection
              title={tI18nComplete.raw('text01e3fecd5bfb')}
              description={tI18nComplete.raw('text8070bf46e184')}
            >
              <AdminPanel className="space-y-2">
                <div className="flex items-center gap-2">
                  <currentLevelDef.icon
                    weight="fill"
                    className={`size-4 shrink-0 ${MAINTENANCE_TONE_GLYPH[currentLevelDef.tone]}`}
                  />
                  <span className="text-foreground text-sm font-medium">
                    {config.title || currentLevelDef.label}
                  </span>
                </div>
                {config.message && (
                  <p className="text-muted-foreground text-xs leading-relaxed">{config.message}</p>
                )}
                {config.affectedServices && config.affectedServices.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {config.affectedServices.map((s) => (
                      <Badge key={s} variant="secondary" size="sm">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
                {config.updatedAt && (
                  <p className="text-muted-foreground flex items-center gap-1 pt-1 text-xs">
                    <ClockIcon className="size-3 shrink-0" />
                    {tI18nComplete.raw('text3a5ecca188c0')}
                    {updatedAtFormatter.format(new Date(config.updatedAt))}
                  </p>
                )}
              </AdminPanel>
            </AdminSection>
          )}

          <AdminSection
            title={tI18nComplete.raw('textfe9d9df993af')}
            description={tI18nComplete.raw('texta21a3edd0a56')}
          >
            <div className="space-y-2">
              {MAINTENANCE_LEVELS.map((level) => (
                <MaintenanceLevelRow
                  key={level.value}
                  level={level.value}
                  isSelected={currentLevel === level.value}
                  onClick={() => handleLevelClick(level.value)}
                />
              ))}
            </div>
          </AdminSection>
        </>
      )}

      <MaintenanceConfigModal
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        level={selectedLevel}
        title={title}
        setTitle={setTitle}
        message={message}
        setMessage={setMessage}
        startDate={startDate}
        setStartDate={setStartDate}
        endDate={endDate}
        setEndDate={setEndDate}
        statusUrl={statusUrl}
        setStatusUrl={setStatusUrl}
        services={services}
        toggleService={toggleService}
        onSave={handleSave}
        isPending={updateConfig.isPending}
      />
    </AdminPageShell>
  );
}
