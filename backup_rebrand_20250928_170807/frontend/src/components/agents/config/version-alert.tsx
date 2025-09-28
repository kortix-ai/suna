import React from 'react';
import { Eye, Check, Loader2, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface VersionAlertProps {
  versionData?: {
    version_id: string;
    version_name: string;
  };
  isActivating: boolean;
  onActivateVersion: (versionId: string) => void;
}

export function VersionAlert({
  versionData,
  isActivating,
  onActivateVersion,
}: VersionAlertProps) {
  if (!versionData) return null;

  return (
    <div className="mb-4 w-full bg-primary/5 border shadow-xs border-primary/10 p-2 rounded-xl">
      <div className="flex items-center gap-2">
        <AlertDescription className="text-primary text-sm flex items-center gap-2 flex-1">
            <Info className="h-4 w-4 text-primary" />
            <span>You are viewing a read-only version of the agent</span>
        </AlertDescription>
        <Button variant="outline" size="sm" onClick={() => onActivateVersion(versionData.version_id)}>
            Activate
        </Button>
      </div>
    </div>
  );
} 