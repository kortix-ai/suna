/**
 * Platform API client.
 *
 * The legacy account-level sandbox lifecycle API was removed. This adapter
 * keeps older instance UI call sites pointed at the supported project-session
 * endpoints under /projects/:projectId/sessions/:sessionId.
 *
 * This module was split into focused submodules for maintainability. The barrel
 * below re-exports the exact original public surface; shared internal helpers in
 * ./shared are intentionally not re-exported.
 */

export * from './types';
export * from './urls';
export * from './lifecycle';
export * from './members';
export * from './invites';
export * from './backups';
export * from './ssh';
export * from './updates';
export * from './instance-admin';
export * from './github-app';
