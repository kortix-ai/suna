import type { ComponentType } from 'react';
import type { ToolPart } from '@/ui';

export interface ToolProps {
  part: ToolPart;
  sessionId?: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  hasActiveQuestion?: boolean;
  onPermissionReply?: (requestId: string, reply: 'once' | 'always' | 'reject') => void;
}

export type ToolComponent = ComponentType<ToolProps>;

export interface BasicToolProps {
  icon?: React.ReactNode;
  trigger: import('@/ui').TriggerTitle | React.ReactNode;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  onSubtitleClick?: () => void;
  badge?: React.ReactNode;
  rightAccessory?: React.ReactNode;
  onClick?: () => void;
  durationMs?: number;
  className?: string;
}

export interface ParsedJsonFailure {
  errorSummary: string;
  hint?: string;
  status?: number;
  nestedMessage?: string;
  nestedError?: boolean;
}
