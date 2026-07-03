/**
 * Shared session UI primitives — framework-agnostic.
 *
 * Import from '@/ui' for types, turn grouping, part helpers, and status text.
 * The turn helpers live in `@kortix/sdk/turns` (single implementation shared
 * with mobile); this barrel re-exports them alongside the web view-model types.
 *
 * IMPORTANT: No React / DOM / framework imports in this folder.
 */

export * from './types';
export * from '@kortix/sdk/turns';
