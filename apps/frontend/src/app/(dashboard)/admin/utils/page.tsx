"use client";

import { useState, useEffect } from "react";
import { Settings, Clock } from "lucide-react";
import { KortixLoader } from '@/components/ui/kortix-loader';
import { toast } from "@/lib/toast";
import {
  useSystemStatus,
  useUpdateMaintenanceNotice,
  useUpdateTechnicalIssue,
} from "@/hooks/admin/use-system-status";
import {
  MaintenanceCard,
  TechnicalIssueCard,
  MaintenanceDialog,
  TechnicalIssueDialog,
} from "./_components";

export default function AdminUtilsPage() {
  const { data: status, isLoading } = useSystemStatus();
  const updateMaintenance = useUpdateMaintenanceNotice();
  const updateTechnicalIssue = useUpdateTechnicalIssue();

  const [maintenanceDialogOpen, setMaintenanceDialogOpen] = useState(false);
  const [technicalIssueDialogOpen, setTechnicalIssueDialogOpen] = useState(false);

  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceStartDate, setMaintenanceStartDate] = useState<Date | undefined>(undefined);
  const [maintenanceEndDate, setMaintenanceEndDate] = useState<Date | undefined>(undefined);

  const [technicalIssueEnabled, setTechnicalIssueEnabled] = useState(false);
  const [technicalIssueMessage, setTechnicalIssueMessage] = useState('');
  const [technicalIssueSeverity, setTechnicalIssueSeverity] = useState<'degraded' | 'outage' | 'maintenance'>('degraded');
  const [technicalIssueDescription, setTechnicalIssueDescription] = useState('');
  const [technicalIssueResolution, setTechnicalIssueResolution] = useState('');
  const [technicalIssueServices, setTechnicalIssueServices] = useState<string[]>([]);
  const [technicalIssueStatusUrl, setTechnicalIssueStatusUrl] = useState('/status');

  useEffect(() => {
    if (status) {
      setMaintenanceEnabled(status.maintenance_notice.enabled);
      setMaintenanceStartDate(status.maintenance_notice.start_time ? new Date(status.maintenance_notice.start_time) : undefined);
      setMaintenanceEndDate(status.maintenance_notice.end_time ? new Date(status.maintenance_notice.end_time) : undefined);

      setTechnicalIssueEnabled(status.technical_issue.enabled);
      setTechnicalIssueMessage(status.technical_issue.message || '');
      setTechnicalIssueSeverity(status.technical_issue.severity || 'degraded');
      setTechnicalIssueDescription(status.technical_issue.description || '');
      setTechnicalIssueResolution(status.technical_issue.estimated_resolution || '');
      setTechnicalIssueServices(status.technical_issue.affected_services || []);
      setTechnicalIssueStatusUrl(status.technical_issue.status_url || '/status');
    }
  }, [status]);

  const handleSaveMaintenance = async () => {
    try {
      await updateMaintenance.mutateAsync({
        enabled: maintenanceEnabled,
        start_time: maintenanceEnabled && maintenanceStartDate ? maintenanceStartDate.toISOString() : null,
        end_time: maintenanceEnabled && maintenanceEndDate ? maintenanceEndDate.toISOString() : null,
      });
      toast.success(maintenanceEnabled ? "Maintenance notice enabled" : "Maintenance notice disabled");
      setMaintenanceDialogOpen(false);
    } catch {
      toast.error("Failed to update maintenance notice");
    }
  };

  const handleSaveTechnicalIssue = async () => {
    try {
      await updateTechnicalIssue.mutateAsync({
        enabled: technicalIssueEnabled,
        message: technicalIssueEnabled ? technicalIssueMessage : null,
        severity: technicalIssueEnabled ? technicalIssueSeverity : null,
        description: technicalIssueEnabled ? technicalIssueDescription : null,
        estimated_resolution: technicalIssueEnabled ? technicalIssueResolution : null,
        affected_services: technicalIssueEnabled && technicalIssueServices.length > 0 ? technicalIssueServices : null,
        status_url: technicalIssueEnabled ? technicalIssueStatusUrl : null,
      });
      toast.success(technicalIssueEnabled ? "Technical issue banner enabled" : "Technical issue banner disabled");
      setTechnicalIssueDialogOpen(false);
    } catch {
      toast.error("Failed to update technical issue");
    }
  };

  const toggleService = (serviceLabel: string) => {
    setTechnicalIssueServices(prev => 
      prev.includes(serviceLabel)
        ? prev.filter(s => s !== serviceLabel)
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

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-none">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10">
              <Settings className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Admin Utils</h1>
              <p className="text-sm text-muted-foreground">
                System utilities and status management
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <div className="grid gap-4">
            <MaintenanceCard
              enabled={status?.maintenance_notice.enabled ?? false}
              onClick={() => setMaintenanceDialogOpen(true)}
            />

            <TechnicalIssueCard
              enabled={status?.technical_issue.enabled ?? false}
              message={status?.technical_issue.message}
              onClick={() => setTechnicalIssueDialogOpen(true)}
            />
          </div>

          {status?.updated_at && (
            <p className="text-xs text-muted-foreground mt-6 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Last updated: {new Date(status.updated_at).toLocaleString()}
            </p>
          )}
        </div>
      </div>

      <MaintenanceDialog
        open={maintenanceDialogOpen}
        onOpenChange={setMaintenanceDialogOpen}
        enabled={maintenanceEnabled}
        setEnabled={setMaintenanceEnabled}
        startDate={maintenanceStartDate}
        setStartDate={setMaintenanceStartDate}
        endDate={maintenanceEndDate}
        setEndDate={setMaintenanceEndDate}
        onSave={handleSaveMaintenance}
        isPending={updateMaintenance.isPending}
      />

      <TechnicalIssueDialog
        open={technicalIssueDialogOpen}
        onOpenChange={setTechnicalIssueDialogOpen}
        enabled={technicalIssueEnabled}
        setEnabled={setTechnicalIssueEnabled}
        message={technicalIssueMessage}
        setMessage={setTechnicalIssueMessage}
        severity={technicalIssueSeverity}
        setSeverity={setTechnicalIssueSeverity}
        description={technicalIssueDescription}
        setDescription={setTechnicalIssueDescription}
        resolution={technicalIssueResolution}
        setResolution={setTechnicalIssueResolution}
        services={technicalIssueServices}
        toggleService={toggleService}
        statusUrl={technicalIssueStatusUrl}
        setStatusUrl={setTechnicalIssueStatusUrl}
        onSave={handleSaveTechnicalIssue}
        isPending={updateTechnicalIssue.isPending}
      />
    </div>
  );
}
