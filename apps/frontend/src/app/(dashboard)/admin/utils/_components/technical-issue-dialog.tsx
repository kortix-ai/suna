"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, AlertCircle, XCircle, Wrench, Loader2 } from "lucide-react";
import { AVAILABLE_SERVICES } from "./constants";

type Severity = 'degraded' | 'outage' | 'maintenance';

interface TechnicalIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  message: string;
  setMessage: (message: string) => void;
  severity: Severity;
  setSeverity: (severity: Severity) => void;
  description: string;
  setDescription: (description: string) => void;
  resolution: string;
  setResolution: (resolution: string) => void;
  services: string[];
  toggleService: (service: string) => void;
  statusUrl: string;
  setStatusUrl: (url: string) => void;
  onSave: () => Promise<void>;
  isPending: boolean;
}

export function TechnicalIssueDialog({
  open,
  onOpenChange,
  enabled,
  setEnabled,
  message,
  setMessage,
  severity,
  setSeverity,
  description,
  setDescription,
  resolution,
  setResolution,
  services,
  toggleService,
  statusUrl,
  setStatusUrl,
  onSave,
  isPending,
}: TechnicalIssueDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            Technical Issue Banner
          </DialogTitle>
          <DialogDescription>
            Alert users about ongoing issues or degraded performance
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="issue-enabled">Enable technical issue banner</Label>
            <Switch
              id="issue-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>

          {enabled && (
            <>
              <div className="space-y-2">
                <Label>Severity</Label>
                <Select value={severity} onValueChange={(v: Severity) => setSeverity(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="degraded">
                      <span className="flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-orange-500" />
                        Degraded Performance
                      </span>
                    </SelectItem>
                    <SelectItem value="outage">
                      <span className="flex items-center gap-2">
                        <XCircle className="w-4 h-4 text-destructive" />
                        Major Outage
                      </span>
                    </SelectItem>
                    <SelectItem value="maintenance">
                      <span className="flex items-center gap-2">
                        <Wrench className="w-4 h-4 text-amber-500" />
                        Under Maintenance
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="message">Message</Label>
                <Input
                  id="message"
                  placeholder="e.g., We're experiencing high demand"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description (optional)</Label>
                <Textarea
                  id="description"
                  placeholder="More details about the issue..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label>Affected Services</Label>
                <div className="grid grid-cols-2 gap-2">
                  {AVAILABLE_SERVICES.map((service) => {
                    const Icon = service.icon;
                    const isSelected = services.includes(service.label);
                    return (
                      <div
                        key={service.id}
                        onClick={() => toggleService(service.label)}
                        className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors text-sm ${
                          isSelected 
                            ? 'border-primary bg-primary/5' 
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <Checkbox checked={isSelected} />
                        <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                        <span>{service.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="resolution">Est. Resolution</Label>
                  <Input
                    id="resolution"
                    placeholder="e.g., ~2 hours"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status-url">Status URL</Label>
                  <Input
                    id="status-url"
                    placeholder="/status"
                    value={statusUrl}
                    onChange={(e) => setStatusUrl(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={onSave}
            disabled={isPending || (enabled && !message)}
          >
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
