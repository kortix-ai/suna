"use client";

import { cn } from '@/lib/utils';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { DateTimePicker } from "./date-time-picker";
import { AVAILABLE_SERVICES, MAINTENANCE_LEVELS } from "./constants";
import type { MaintenanceLevel } from "@/lib/maintenance-store";

interface MaintenanceConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  level: MaintenanceLevel;
  title: string;
  setTitle: (title: string) => void;
  message: string;
  setMessage: (message: string) => void;
  startDate: Date | undefined;
  setStartDate: (date: Date | undefined) => void;
  endDate: Date | undefined;
  setEndDate: (date: Date | undefined) => void;
  statusUrl: string;
  setStatusUrl: (url: string) => void;
  services: string[];
  toggleService: (service: string) => void;
  onSave: () => Promise<void>;
  isPending: boolean;
}

export function MaintenanceConfigDialog({
  open,
  onOpenChange,
  level,
  title,
  setTitle,
  message,
  setMessage,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  statusUrl,
  setStatusUrl,
  services,
  toggleService,
  onSave,
  isPending,
}: MaintenanceConfigDialogProps) {
  const levelConfig = MAINTENANCE_LEVELS.find((l) => l.value === level);
  const Icon = levelConfig?.icon;
  const isNone = level === 'none';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {Icon && <Icon className={cn('w-5 h-5', levelConfig?.color)} />}
            Configure {levelConfig?.label || 'Maintenance'}
          </DialogTitle>
          <DialogDescription>
            {isNone
              ? 'This will clear all active maintenance notifications.'
              : `Set up the ${levelConfig?.label?.toLowerCase()} notification that users will see.`}
          </DialogDescription>
        </DialogHeader>

        {!isNone && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="m-title">Title</Label>
              <Input
                id="m-title"
                placeholder={levelConfig?.label || 'Maintenance'}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="m-message">Message</Label>
              <Textarea
                id="m-message"
                placeholder="Describe the situation..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
              />
            </div>

            {(level === 'warning' || level === 'blocking') && (
              <div className="grid grid-cols-2 gap-3">
                <DateTimePicker
                  label="Start Time"
                  date={startDate}
                  setDate={setStartDate}
                />
                <DateTimePicker
                  label="End Time"
                  date={endDate}
                  setDate={setEndDate}
                />
              </div>
            )}

            {(level === 'critical' || level === 'blocking') && (
              <div className="space-y-2">
                <Label>Affected Services</Label>
                <div className="grid grid-cols-2 gap-2">
                  {AVAILABLE_SERVICES.map((service) => {
                    const SvcIcon = service.icon;
                    const isSelected = services.includes(service.label);
                    return (
                      <div
                        key={service.id}
                        onClick={() => toggleService(service.label)}
                        className={cn(
                          'flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors text-sm',
                          isSelected
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50',
                        )}
                      >
                        <Checkbox checked={isSelected} />
                        <SvcIcon
                          className={cn(
                            'w-3.5 h-3.5',
                            isSelected ? 'text-primary' : 'text-muted-foreground',
                          )}
                        />
                        <span>{service.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="m-status-url">Status URL (optional)</Label>
              <Input
                id="m-status-url"
                placeholder="https://status.yourapp.com"
                value={statusUrl}
                onChange={(e) => setStatusUrl(e.target.value)}
              />
            </div>
          </div>
        )}

        {isNone && (
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              Clicking save will clear all maintenance notifications and restore normal access.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={isPending || (!isNone && !message)}
            variant={level === 'blocking' || level === 'critical' ? 'destructive' : 'default'}
          >
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {isNone ? 'Clear & Save' : 'Activate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
