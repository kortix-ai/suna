import type { MaintenanceLevel } from '@/lib/maintenance-store';
import {
  InfoIcon,
  ShieldIcon,
  ShieldSlashIcon,
  WarningCircleIcon,
  WarningIcon,
  DatabaseIcon,
  GlobeIcon,
  LightningIcon,
  type Icon,
} from '@phosphor-icons/react';

/**
 * How loud a level is. Only ever a `kortix-*` accent — the previous revision
 * carried three hand-written class strings per level (`text-blue-500`,
 * `bg-blue-500/10`, `border-blue-500/20`), which is a raw Tailwind palette that
 * does not flip in dark mode and a second border colour on top of it.
 *
 * `critical` and `blocking` share `danger` on purpose. They are both red
 * because they are both outages; what separates them is what they DO, which
 * the label and description say in words. Inventing a darker red for the
 * second one would encode severity in a hue nobody can decode.
 */
export type MaintenanceTone = 'neutral' | 'info' | 'warning' | 'danger';

export const MAINTENANCE_TONE_TILE: Record<MaintenanceTone, string> = {
  neutral: 'bg-muted',
  info: 'bg-kortix-blue/15',
  warning: 'bg-kortix-orange/15',
  danger: 'bg-kortix-red/15',
};

export const MAINTENANCE_TONE_GLYPH: Record<MaintenanceTone, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-kortix-blue',
  warning: 'text-kortix-orange',
  danger: 'text-kortix-red',
};

export const MAINTENANCE_LEVELS: {
  value: MaintenanceLevel;
  label: string;
  description: string;
  icon: Icon;
  tone: MaintenanceTone;
}[] = [
  {
    value: 'none',
    label: 'Off',
    description: 'Nothing is announced. Normal access for everyone.',
    icon: InfoIcon,
    tone: 'neutral',
  },
  {
    value: 'info',
    label: 'Info banner',
    description: 'Dismissible. For announcements and shipped changes.',
    icon: InfoIcon,
    tone: 'info',
  },
  {
    value: 'warning',
    label: 'Warning banner',
    description: 'Dismissible. For maintenance that has not started yet.',
    icon: WarningIcon,
    tone: 'warning',
  },
  {
    value: 'critical',
    label: 'Critical banner',
    description: 'Not dismissible. For an outage or incident in progress.',
    icon: WarningCircleIcon,
    tone: 'danger',
  },
  {
    value: 'blocking',
    label: 'Full lockdown',
    description: 'Blocks all access and redirects everyone to the maintenance page.',
    icon: ShieldSlashIcon,
    tone: 'danger',
  },
];

export const AVAILABLE_SERVICES = [
  { id: 'agent-runner', label: 'Agent Runner', icon: LightningIcon },
  { id: 'web-application', label: 'Web Application', icon: GlobeIcon },
  { id: 'database', label: 'Database', icon: DatabaseIcon },
  { id: 'authentication', label: 'Authentication', icon: ShieldIcon },
] as const;

export type ServiceId = (typeof AVAILABLE_SERVICES)[number]['id'];
export type ServiceLabel = (typeof AVAILABLE_SERVICES)[number]['label'];
