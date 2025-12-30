'use client';

import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, CheckCircle, Clock, Wrench, Activity, Shield, Database, Globe, Zap } from 'lucide-react';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { useTechnicalIssueQuery } from '@/hooks/edge-flags';
import { AnimatedBg } from '@/components/ui/animated-bg';

interface StatusItem {
  service: string;
  status: 'operational' | 'degraded' | 'outage' | 'maintenance';
  description?: string;
  icon: React.ComponentType<any>;
}

const defaultStatusItems: StatusItem[] = [
  { service: 'Agent Runner', status: 'operational', icon: Zap },
  { service: 'Web Application', status: 'operational', icon: Globe },
  { service: 'Database', status: 'operational', icon: Database },
  { service: 'Authentication', status: 'operational', icon: Shield },
];

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'operational':
      return <CheckCircle className="h-4 w-4 text-emerald-500" />;
    case 'degraded':
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    case 'outage':
      return <AlertTriangle className="h-4 w-4 text-red-500" />;
    case 'maintenance':
      return <Wrench className="h-4 w-4 text-blue-500" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'operational':
      return 'bg-green-500/10 text-green-700 dark:text-green-400';
    case 'degraded':
      return 'bg-destructive/10 text-destructive';
    case 'outage':
      return 'bg-destructive/20 text-destructive';
    case 'maintenance':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
};

function StatusPageContent() {
  const { data: technicalIssue } = useTechnicalIssueQuery();
  
  const statusItems = defaultStatusItems.map(item => {
    if (technicalIssue?.enabled && technicalIssue.affectedServices?.includes(item.service)) {
      const severity = technicalIssue.severity || 'degraded';
      const getDescription = (status: string) => {
        switch (status) {
          case 'degraded':
            return 'Experiencing performance issues';
          case 'outage':
            return 'Service is currently unavailable';
          case 'maintenance':
            return 'Under maintenance';
          default:
            return 'Currently experiencing issues';
        }
      };
      
      return {
        ...item,
        status: severity,
        description: getDescription(severity)
      };
    }
    return item;
  });

  const overallStatus = statusItems.some(item => item.status === 'outage') 
    ? 'outage' 
    : statusItems.some(item => item.status === 'degraded')
    ? 'degraded'
    : statusItems.some(item => item.status === 'maintenance')
    ? 'maintenance'
    : 'operational';

  return (
    <div className="w-full relative overflow-hidden min-h-screen">
      <div className="relative flex flex-col w-full min-h-screen">
        <AnimatedBg variant="hero" />
        <div className="relative z-10 flex flex-col items-center px-4 sm:px-6 pt-16 pb-8">
          <div className="flex flex-col items-center gap-6 text-center">
            <KortixLogo size={32} />
            <div className="space-y-2">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                System Status
              </h1>
              <p className="text-sm text-muted-foreground max-w-md">
                Real-time status of all Kortix services
              </p>
            </div>
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-sm border ${
                overallStatus === 'operational' 
                  ? 'bg-green-500/10 border-green-200 dark:border-green-800' 
                  : overallStatus === 'degraded'
                  ? 'bg-destructive/10 border-destructive/20'
                  : 'bg-destructive/20 border-destructive/30'
              }`}
            >
              {getStatusIcon(overallStatus)}
              <span className="text-sm font-medium">
                {overallStatus === 'operational' && 'All Systems Operational'}
                {overallStatus === 'degraded' && 'Some Systems Experiencing Issues'}
                {overallStatus === 'outage' && 'Service Disruption Detected'}
                {overallStatus === 'maintenance' && 'Scheduled Maintenance in Progress'}
              </span>
            </div>
          </div>
        </div>
        {technicalIssue?.enabled && (
          <div className="relative z-10 px-4 sm:px-6 mb-8">
            <div className="max-w-4xl mx-auto">
              <div className="relative overflow-hidden rounded-xl bg-zinc-50 dark:bg-zinc-900 border border-border backdrop-blur-sm">
                <div className="relative p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 p-2 rounded-full bg-destructive/20">
                      <AlertTriangle className="h-4 w-4 text-destructive" />
                    </div>
                    <div className="flex-1 space-y-2">
                      <h3 className="text-base font-semibold text-foreground">
                        {technicalIssue.message}
                      </h3>
                      {technicalIssue.description && (
                        <p className="text-sm text-muted-foreground">
                          {technicalIssue.description}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-3 text-xs">
                        {technicalIssue.affectedServices && technicalIssue.affectedServices.length > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="font-medium">Affected:</span>
                            <div className="flex flex-wrap gap-1">
                              {technicalIssue.affectedServices.map((service, idx) => (
                                <Badge key={idx} variant="secondary" className="bg-destructive/10 text-destructive text-xs py-1">
                                  {service}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {technicalIssue.estimatedResolution && (
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3 text-muted-foreground" />
                            <span className="font-medium">ETA:</span>
                            <span className="text-muted-foreground">{technicalIssue.estimatedResolution}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t border-destructive/10">
                        <Activity className="h-3 w-3" />
                        <span>We are actively working to resolve this issue.</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="relative z-10 flex-1 px-4 sm:px-6 pb-16">
          <div className="max-w-4xl mx-auto space-y-6">
            <Card className="bg-card/50 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Activity className="h-4 w-4 text-primary" />
                  Service Status
                </CardTitle>
                <CardDescription className="text-sm">
                  Current operational status of all Kortix services
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {statusItems.map((item, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 rounded-xl border bg-card/30 hover:bg-card/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl border bg-primary/10">
                          <item.icon className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <div className="font-medium text-sm">{item.service}</div>
                          {item.description && (
                            <div className="text-xs text-muted-foreground">{item.description}</div>
                          )}
                        </div>
                      </div>
                      <Badge className={getStatusColor(item.status)} variant="secondary">
                        {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <div className="text-center space-y-1 text-xs text-muted-foreground">
              <p>This page is updated automatically when issues are detected.</p>
              <p>For support inquiries, please contact our team.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StatusPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
        </div>
      }
    >
      <StatusPageContent />
    </Suspense>
  );
}
