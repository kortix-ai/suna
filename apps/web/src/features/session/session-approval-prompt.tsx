'use client';

/**
 * @deprecated Task WS5-P1-c collapsed this into the ONE on-system permission
 * surface, `permission-prompt/permission-prompt.tsx` — the connector
 * "requires approval" card here and `acp-session-permission-prompt.tsx`'s
 * ACP wire-level card now render as rows in the same design-system
 * container instead of stacking two separate amber cards above the
 * composer. Kept as a thin re-export (never delete public surface) purely
 * so an out-of-tree import of this name keeps resolving; unlike this
 * component's original self-contained (`useParams`-driven) shape, the
 * unified component takes `projectId`/`sessionId` as explicit props —
 * `acp-session-chat.tsx` mounts it directly with the props it already has
 * in scope.
 */
export { PermissionPrompt as SessionApprovalPrompt } from './permission-prompt/permission-prompt';
