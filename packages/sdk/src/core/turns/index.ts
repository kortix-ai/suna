/**
 * Turn grouping & part helpers — framework-agnostic. See the individual
 * modules for implementation: `parts.ts`, `grouping.ts`, `shell.ts`, `state.ts`.
 * `segments/` turns parts into transcript rows; `tools/` presents tool calls.
 */
export type * from './types';
export * from './classify';
export * from './errors';
export * from './grouping';
export * from './open-turn';
export * from './parts';
export * from './segments';
export * from './shell';
export * from './state';
export * from './tool-registry';
export * from './tools';
export * from './view-model';
