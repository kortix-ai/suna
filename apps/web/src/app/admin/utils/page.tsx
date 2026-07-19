'use client';

import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { KortixHyperLogo } from '@/components/ui/marketing/kortix-hyper-logo';
import {
  useMaintenanceAdmin,
  useUpdateMaintenanceConfig,
} from '@/hooks/admin/use-maintenance-admin';
import type { MaintenanceLevel } from '@/lib/maintenance-store';
import { toast } from '@/lib/toast';
import { ClockIcon as Clock, GearIcon as Settings } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { MAINTENANCE_LEVELS, MaintenanceConfigDialog, MaintenanceLevelCard } from './_components';

export default function AdminUtilsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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

  // Sync form state when config loads or changes
  useEffect(() => {
    if (config) {
      setSelectedLevel(config.level);
      setTitle(config.title || '');
      setMessage(config.message || '');
      setStartDate(config.startTime ? new Date(config.startTime) : undefined);
      setEndDate(config.endTime ? new Date(config.endTime) : undefined);
      setStatusUrl(config.statusUrl || '');
      setServices(config.affectedServices || []);
    }
  }, [config]);

  const handleLevelClick = (level: MaintenanceLevel) => {
    setSelectedLevel(level);

    // Pre-fill title from level config if empty
    if (!title || title === MAINTENANCE_LEVELS.find((l) => l.value === config?.level)?.label) {
      const levelDef = MAINTENANCE_LEVELS.find((l) => l.value === level);
      if (levelDef && level !== 'none') {
        setTitle(levelDef.label);
      }
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
        toast.success('Maintenance notifications cleared');
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
        toast.success(`${levelDef?.label || 'Maintenance'} activated`);
      }

      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update maintenance config');
    }
  };

  const toggleService = (serviceLabel: string) => {
    setServices((prev) =>
      prev.includes(serviceLabel)
        ? prev.filter((s) => s !== serviceLabel)
        : [...prev, serviceLabel],
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <KortixHyperLogo size={72} startOnView={false} loop className="text-foreground" />
      </div>
    );
  }

  const currentLevel = config?.level || 'none';
  const currentLevelDef = MAINTENANCE_LEVELS.find((l) => l.value === currentLevel);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-none">
        <div className="mx-auto max-w-4xl px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-2xl">
              <Settings className="text-primary h-5 w-5" />
            </div>
            <div className="flex-1">
              <h1 className="text-2xl font-semibold tracking-tight">
                {tHardcodedUi.raw('appAdminUtilsPage.line126JsxTextMaintenanceNotifications')}
              </h1>
              <p className="text-muted-foreground text-sm">
                {tHardcodedUi.raw(
                  'appAdminUtilsPage.line129JsxTextControlSystemWideMaintenanceBannersAndAccessRestrictions',
                )}
              </p>
            </div>
            {currentLevel !== 'none' && currentLevelDef && (
              <Badge
                className={`${currentLevelDef.bgColor} ${currentLevelDef.color} ${currentLevelDef.borderColor} border`}
              >
                {currentLevelDef.label}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 pb-6">
          {/* Current status summary */}
          {currentLevel !== 'none' && config && (
            <div className="bg-muted/30 mb-6 rounded-2xl border p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                {currentLevelDef && (
                  <currentLevelDef.icon className={`h-4 w-4 ${currentLevelDef.color}`} />
                )}
                {tHardcodedUi.raw('appAdminUtilsPage.line152JsxTextCurrentlyActive')}
                {currentLevelDef?.label}
              </div>
              {config.title && <p className="text-sm font-medium">{config.title}</p>}
              {config.message && (
                <p className="text-muted-foreground mt-1 text-xs">{config.message}</p>
              )}
              {config.affectedServices && config.affectedServices.length > 0 && (
                <div className="mt-2 flex gap-1.5">
                  {config.affectedServices.map((s) => (
                    <Badge key={s} variant="secondary" className="text-xs">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Level selection grid */}
          <div className="space-y-2">
            <p className="text-muted-foreground mb-3 text-sm font-medium">
              {tHardcodedUi.raw(
                'appAdminUtilsPage.line177JsxTextSelectANotificationLevelToConfigure',
              )}
            </p>
            {MAINTENANCE_LEVELS.map((level) => (
              <MaintenanceLevelCard
                key={level.value}
                level={level.value}
                isSelected={currentLevel === level.value}
                onClick={() => handleLevelClick(level.value)}
              />
            ))}
          </div>

          {config?.updatedAt && (
            <p className="text-muted-foreground mt-6 flex items-center gap-1 text-xs">
              <Clock className="h-3 w-3" />
              {tHardcodedUi.raw('appAdminUtilsPage.line192JsxTextLastUpdated')}
              {new Date(config.updatedAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>

      <MaintenanceConfigDialog
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
    </div>
  );
}
