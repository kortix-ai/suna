"use client";

import { useState, useEffect } from "react";
import { Settings, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { KortixLoader } from "@/components/ui/kortix-loader";
import { toast } from "@/lib/toast";
import {
  useMaintenanceAdmin,
  useUpdateMaintenanceConfig,
} from "@/hooks/admin/use-maintenance-admin";
import {
  MaintenanceLevelCard,
  MaintenanceConfigDialog,
  MAINTENANCE_LEVELS,
} from "./_components";
import type { MaintenanceLevel } from "@/lib/maintenance-store";

export default function AdminUtilsPage() {
  const { data: config, isLoading } = useMaintenanceAdmin();
  const updateConfig = useUpdateMaintenanceConfig();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState<MaintenanceLevel>("none");

  // Form state
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [statusUrl, setStatusUrl] = useState("");
  const [services, setServices] = useState<string[]>([]);

  // Sync form state when config loads or changes
  useEffect(() => {
    if (config) {
      setSelectedLevel(config.level);
      setTitle(config.title || "");
      setMessage(config.message || "");
      setStartDate(config.startTime ? new Date(config.startTime) : undefined);
      setEndDate(config.endTime ? new Date(config.endTime) : undefined);
      setStatusUrl(config.statusUrl || "");
      setServices(config.affectedServices || []);
    }
  }, [config]);

  const handleLevelClick = (level: MaintenanceLevel) => {
    setSelectedLevel(level);

    // Pre-fill title from level config if empty
    if (!title || title === MAINTENANCE_LEVELS.find((l) => l.value === config?.level)?.label) {
      const levelDef = MAINTENANCE_LEVELS.find((l) => l.value === level);
      if (levelDef && level !== "none") {
        setTitle(levelDef.label);
      }
    }

    setDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      if (selectedLevel === "none") {
        await updateConfig.mutateAsync({
          level: "none",
          title: "",
          message: "",
          startTime: null,
          endTime: null,
          statusUrl: null,
          affectedServices: [],
        });
        toast.success("Maintenance notifications cleared");
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
        toast.success(`${levelDef?.label || "Maintenance"} activated`);
      }

      setDialogOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update maintenance config"
      );
    }
  };

  const toggleService = (serviceLabel: string) => {
    setServices((prev) =>
      prev.includes(serviceLabel)
        ? prev.filter((s) => s !== serviceLabel)
        : [...prev, serviceLabel]
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <KortixLoader size="large" />
      </div>
    );
  }

  const currentLevel = config?.level || "none";
  const currentLevelDef = MAINTENANCE_LEVELS.find((l) => l.value === currentLevel);

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-none">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10">
              <Settings className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1">
              <h1 className="text-2xl font-semibold tracking-tight">
                Maintenance Notifications
              </h1>
              <p className="text-sm text-muted-foreground">
                Control system-wide maintenance banners and access restrictions
              </p>
            </div>
            {currentLevel !== "none" && currentLevelDef && (
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
        <div className="max-w-4xl mx-auto px-6 pb-6">
          {/* Current status summary */}
          {currentLevel !== "none" && config && (
            <div className="mb-6 rounded-xl border bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-medium mb-2">
                {currentLevelDef && (
                  <currentLevelDef.icon className={`w-4 h-4 ${currentLevelDef.color}`} />
                )}
                Currently active: {currentLevelDef?.label}
              </div>
              {config.title && (
                <p className="text-sm font-medium">{config.title}</p>
              )}
              {config.message && (
                <p className="text-xs text-muted-foreground mt-1">
                  {config.message}
                </p>
              )}
              {config.affectedServices && config.affectedServices.length > 0 && (
                <div className="flex gap-1.5 mt-2">
                  {config.affectedServices.map((s) => (
                    <Badge key={s} variant="secondary" className="text-[10px]">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Level selection grid */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground mb-3">
              Select a notification level to configure
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
            <p className="text-xs text-muted-foreground mt-6 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Last updated: {new Date(config.updatedAt).toLocaleString()}
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
