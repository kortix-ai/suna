"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wrench, AlertTriangle, Clock, AlertCircle } from "lucide-react";

interface MaintenanceCardProps {
  enabled: boolean;
  onClick: () => void;
}

export function MaintenanceCard({ enabled, onClick }: MaintenanceCardProps) {
  return (
    <Card 
      className="cursor-pointer hover:border-primary/50 transition-colors p-4"
      onClick={onClick}
    >
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${
              enabled 
                ? 'bg-amber-500/10 border border-amber-500/20' 
                : 'bg-muted'
            }`}>
              <Wrench className={`w-5 h-5 ${
                enabled ? 'text-amber-500' : 'text-muted-foreground'
              }`} />
            </div>
            <div>
              <CardTitle className="text-base">Scheduled Maintenance</CardTitle>
              <CardDescription className="text-xs">
                Show maintenance window to users
              </CardDescription>
            </div>
          </div>
          {enabled ? (
            <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">
              <Clock className="w-3 h-3 mr-1" />
              Active
            </Badge>
          ) : (
            <Badge variant="secondary">Off</Badge>
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

interface TechnicalIssueCardProps {
  enabled: boolean;
  message?: string;
  onClick: () => void;
}

export function TechnicalIssueCard({ enabled, message, onClick }: TechnicalIssueCardProps) {
  return (
    <Card 
      className="cursor-pointer hover:border-primary/50 transition-colors p-4"
      onClick={onClick}
    >
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${
              enabled 
                ? 'bg-destructive/10 border border-destructive/20' 
                : 'bg-muted'
            }`}>
              <AlertTriangle className={`w-5 h-5 ${
                enabled ? 'text-destructive' : 'text-muted-foreground'
              }`} />
            </div>
            <div>
              <CardTitle className="text-base">Technical Issue Banner</CardTitle>
              <CardDescription className="text-xs">
                Alert users about ongoing issues
              </CardDescription>
            </div>
          </div>
          {enabled ? (
            <Badge variant="destructive">
              <AlertCircle className="w-3 h-3 mr-1" />
              Active
            </Badge>
          ) : (
            <Badge variant="secondary">Off</Badge>
          )}
        </div>
      </CardHeader>
      {enabled && message && (
        <CardContent className="pt-0">
          <p className="text-sm text-muted-foreground line-clamp-1">
            {message}
          </p>
        </CardContent>
      )}
    </Card>
  );
}
