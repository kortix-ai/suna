import {
  HardDrive,
  Terminal,
  Monitor,
  type LucideIcon,
} from 'lucide-react';

export interface FilesystemScope {
  paths: string[];
  operations: ('read' | 'write' | 'list' | 'delete')[];
  maxFileSize?: number;
  excludePatterns?: string[];
}

export interface ShellScope {
  commands: string[];
  workingDir?: string;
  maxTimeout?: number;
}

export type PermissionScope = FilesystemScope | ShellScope | Record<string, unknown>;

export interface CapabilityInfo {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  hasScopeEditor: boolean;
}

export const CAPABILITY_REGISTRY: CapabilityInfo[] = [
  {
    key: 'filesystem',
    label: 'Filesystem',
    description: 'Read, write, list, and delete local files',
    icon: HardDrive,
    hasScopeEditor: true,
  },
  {
    key: 'shell',
    label: 'Shell',
    description: 'Execute commands in a local terminal',
    icon: Terminal,
    hasScopeEditor: true,
  },
  {
    key: 'desktop',
    label: 'Computer Use',
    description: 'Inspect and control local desktop apps through CUA Driver',
    icon: Monitor,
    hasScopeEditor: false,
  },
];

export interface ScopeInfo {
  key: string;
  capability: string;
  label: string;
  description: string;
  category: string;
  /**
   * Enforceable scope fields merged into the grant. The backend
   * permission-checker only restricts when the scope carries the fields it
   * understands (e.g. `operations` for filesystem). Without this, a grant is
   * treated as allow-all for the capability — so a quick toggle MUST narrow
   * itself here or it silently grants far more than its label implies.
   * Omit to grant the whole capability (e.g. shell exec, unrestricted).
   */
  grantScope?: Record<string, unknown>;
}

export const SCOPE_REGISTRY: ScopeInfo[] = [
  { key: 'files:read',            capability: 'filesystem', label: 'Read files',          description: 'Read and list local files and directories',    category: 'Filesystem', grantScope: { operations: ['read', 'list'] } },
  { key: 'files:write',           capability: 'filesystem', label: 'Write files',         description: 'Create and modify local files',                category: 'Filesystem', grantScope: { operations: ['write'] } },
  { key: 'files:delete',          capability: 'filesystem', label: 'Delete files',        description: 'Delete local files and directories',           category: 'Filesystem', grantScope: { operations: ['delete'] } },
  { key: 'shell:exec',            capability: 'shell',      label: 'Execute commands',    description: 'Run shell commands in terminal',               category: 'Shell' },
  { key: 'desktop:computer_use',   capability: 'desktop',    label: 'CUA driver',          description: 'Install, start, and inspect CUA Driver',        category: 'Computer Use', grantScope: { features: ['computer_use'] } },
  { key: 'desktop:apps',           capability: 'desktop',    label: 'Applications',        description: 'List, launch, focus, and close apps',           category: 'Computer Use', grantScope: { features: ['apps', 'windows'] } },
  { key: 'desktop:observe',        capability: 'desktop',    label: 'Observe screen',      description: 'Read windows, UI trees, and screenshots',       category: 'Computer Use', grantScope: { features: ['screenshot', 'windows', 'accessibility'] } },
  { key: 'desktop:input',          capability: 'desktop',    label: 'Control input',       description: 'Click, type, hotkey, scroll, and drag',         category: 'Computer Use', grantScope: { features: ['mouse', 'keyboard', 'accessibility'] } },
];

export interface ExpiryOption {
  label: string;
  value: string; 
  ms: number | null; 
}

export const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: '1 hour', value: '1h', ms: 3_600_000 },
  { label: '24 hours', value: '24h', ms: 86_400_000 },
  { label: '7 days', value: '7d', ms: 604_800_000 },
  { label: '30 days', value: '30d', ms: 2_592_000_000 },
  { label: 'Never', value: 'never', ms: null },
];

export function getExpiresAt(option: ExpiryOption): string | undefined {
  if (option.ms === null) return undefined;
  return new Date(Date.now() + option.ms).toISOString();
}

export function getCapabilityInfo(key: string): CapabilityInfo | undefined {
  return CAPABILITY_REGISTRY.find((c) => c.key === key);
}

export function getDefaultScope(capability: string): PermissionScope {
  switch (capability) {
    case 'filesystem':
      return { paths: [], operations: ['read', 'list'], excludePatterns: [] } satisfies FilesystemScope;
    case 'shell':
      return { commands: [], workingDir: '' } satisfies ShellScope;
    default:
      return {};
  }
}
