'use client';

/**
 * @deprecated Task WS5-P1-c collapsed this into the ONE on-system permission
 * surface, `permission-prompt/permission-prompt.tsx` — the ACP wire-level
 * card here and `session-approval-prompt.tsx`'s connector-approval card now
 * render as rows in the same design-system container instead of stacking
 * two separate amber cards above the composer. Kept as a thin re-export
 * (never delete public surface) purely so an out-of-tree import of this
 * name keeps resolving; `acp-session-chat.tsx` mounts the new component
 * directly.
 */
export {
  PermissionPrompt as AcpSessionPermissionPrompt,
  type PermissionPromptProps as AcpSessionPermissionPromptProps,
} from './permission-prompt/permission-prompt';
