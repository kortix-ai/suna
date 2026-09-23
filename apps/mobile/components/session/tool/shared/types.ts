import type { ComponentType } from 'react';
import type { ToolPart } from '@kortix/sdk';

import type { PermissionReply } from '../tool-part-renderer';

/** Props every registered tool renderer receives. Mirrors web `tool/shared/types.ts` `ToolProps`. */
export interface ToolProps {
  part: ToolPart;
  sessionId?: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  hasActiveQuestion?: boolean;
  onPermissionReply?: (requestId: string, reply: PermissionReply) => void;
}

export type ToolComponent = ComponentType<ToolProps>;
