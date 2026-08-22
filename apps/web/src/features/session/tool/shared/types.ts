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
  onClick?: () => void;
  durationMs?: number;
  className?: string;
  /**
   * One interactive control pinned to the far right of the trigger row, on both
   * the inline and panel surfaces.
   *
   * Strictly for an ACTION — a node that carries its own click handler and does
   * something the row itself cannot. A slot that only displays something is
   * `badge`; a slot that displays something and does nothing is chrome, and a
   * trigger row has no room for chrome.
   *
   * The node lives inside the disclosure's own clickable element, so it must
   * `stopPropagation` or activating it also toggles the row, and it must be a
   * `span role="button"` rather than a real `<button>` — nesting one button
   * inside another is invalid HTML. `onSubtitleClick` already works this way.
   */
  triggerAction?: React.ReactNode;
}

export interface ParsedJsonFailure {
  errorSummary: string;
  hint?: string;
  status?: number;
  nestedMessage?: string;
  nestedError?: boolean;
}
