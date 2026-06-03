import {
  AppWindow,
  Cpu,
  HardDrive,
  Terminal,
  Zap,
  type LucideIcon,
} from 'lucide-react';

interface CapabilityInfo {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const CAPABILITY_REGISTRY: CapabilityInfo[] = [
  {
    key: 'filesystem',
    label: 'Filesystem',
    description: 'Read, write, list, and delete local files',
    icon: HardDrive,
  },
  {
    key: 'shell',
    label: 'Shell',
    description: 'Execute commands in a local terminal',
    icon: Terminal,
  },
  {
    key: 'apps',
    label: 'Applications',
    description: 'Launch and interact with local applications',
    icon: AppWindow,
  },
  {
    key: 'hardware',
    label: 'Hardware',
    description: 'Access hardware information and sensors',
    icon: Cpu,
  },
  {
    key: 'gpu',
    label: 'GPU',
    description: 'GPU compute and acceleration',
    icon: Zap,
  },
];
