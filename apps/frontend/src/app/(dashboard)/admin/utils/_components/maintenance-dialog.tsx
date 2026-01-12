"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Wrench, Loader2 } from "lucide-react";
import { DateTimePicker } from "./date-time-picker";

interface MaintenanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  startDate: Date | undefined;
  setStartDate: (date: Date | undefined) => void;
  endDate: Date | undefined;
  setEndDate: (date: Date | undefined) => void;
  onSave: () => Promise<void>;
  isPending: boolean;
}

export function MaintenanceDialog({
  open,
  onOpenChange,
  enabled,
  setEnabled,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  onSave,
  isPending,
}: MaintenanceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="w-5 h-5 text-amber-500" />
            Scheduled Maintenance
          </DialogTitle>
          <DialogDescription>
            Show a banner to users about upcoming or ongoing maintenance
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="maintenance-enabled">Enable maintenance notice</Label>
            <Switch
              id="maintenance-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>

          {enabled && (
            <>
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
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={onSave}
            disabled={isPending || (enabled && (!startDate || !endDate))}
          >
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
