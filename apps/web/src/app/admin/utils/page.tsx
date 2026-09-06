'use client';

import { ClockIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  useMaintenanceAdmin,
  useUpdateMaintenanceConfig,
} from '@/hooks/admin/use-maintenance-admin';
import type { MaintenanceLevel } from '@/lib/maintenance-store';
import { errorToast, successToast } from '@/components/ui/toast';
import { Skeleton } from '@/components/ui/skeleton';

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
        successToast('Maintenance notifications cleared');
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
        successToast(`${levelDef?.label ?? 'Maintenance'} activated`);
      }
      setDialogOpen(false);
    } catch (err) {
      errorToast(err instanceof Error ? err.message : 'Failed to update maintenance config');
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
      title="Maintenance"
      description="System-wide notifications and the full-lockdown switch. A level takes effect the moment it is activated."
      action={
        isActive && currentLevelDef ? (
          <Badge variant="outline" size="sm">
            {currentLevelDef.label} active
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
              title="Currently active"
              description="What every user is seeing right now."
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
                    Updated {updatedAtFormatter.format(new Date(config.updatedAt))}
                  </p>
                )}
              </AdminPanel>
            </AdminSection>
          )}

          <AdminSection
            title="Notification level"
            description="Pick a level to configure and activate it. Higher levels are louder and, at the top, block access entirely."
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
