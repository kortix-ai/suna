import type { ComponentType } from 'react';
import type { ToolCallBlock } from '@kortix/sdk';

import type { PermissionReply } from '../tool-part-renderer';

/** Props every registered tool renderer receives. Mirrors web `tool/shared/types.ts` `ToolProps`. */
export interface ToolProps {
  /** The call to draw: a session-log tool call block. */
  call: ToolCallBlock;
  sessionId?: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  hasActiveQuestion?: boolean;
  onPermissionReply?: (requestId: string, reply: PermissionReply) => void;
}

export type ToolComponent = ComponentType<ToolProps>;
