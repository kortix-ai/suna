import { Info, AlertTriangle, AlertCircle, ShieldOff, Zap, Globe, Database, Shield } from 'lucide-react';
import type { MaintenanceLevel } from '@/lib/maintenance-store';

export const MAINTENANCE_LEVELS: {
  value: MaintenanceLevel;
  label: string;
  description: string;
  icon: typeof Info;
  color: string;
  bgColor: string;
  borderColor: string;
}[] = [
  {
    value: 'none',
    label: 'Off',
    description: 'No active notifications',
    icon: Info,
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
    borderColor: 'border-border',
  },
  {
    value: 'info',
    label: 'Info Banner',
    description: 'Dismissible blue banner — announcements, updates',
    icon: Info,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
  },
  {
    value: 'warning',
    label: 'Warning Banner',
    description: 'Dismissible amber banner — upcoming maintenance',
    icon: AlertTriangle,
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/20',
  },
  {
    value: 'critical',
    label: 'Critical Banner',
    description: 'Non-dismissible red banner — active outage or incident',
    icon: AlertCircle,
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
  },
  {
    value: 'blocking',
    label: 'Full Lockdown',
    description: 'Blocks all access — redirects everyone to maintenance page',
    icon: ShieldOff,
    color: 'text-red-600',
    bgColor: 'bg-red-600/10',
    borderColor: 'border-red-600/20',
  },
];

export const AVAILABLE_SERVICES = [
  { id: 'agent-runner', label: 'Agent Runner', icon: Zap },
  { id: 'web-application', label: 'Web Application', icon: Globe },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'authentication', label: 'Authentication', icon: Shield },
] as const;

export type ServiceId = typeof AVAILABLE_SERVICES[number]['id'];
export type ServiceLabel = typeof AVAILABLE_SERVICES[number]['label'];
