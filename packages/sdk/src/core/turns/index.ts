/**
 * Turn grouping & part helpers — framework-agnostic. See the individual
 * modules for implementation: `parts.ts`, `grouping.ts`, `shell.ts`, `state.ts`.
 * `segments/` turns parts into transcript rows; `tools/` presents tool calls.
 * `subagent-notice.ts`, `peer-message-prompt.ts` and `session-report.ts` read
 * the platform-written prompts (notices, cross-session messages) a host draws
 * as one-line rows.
 */
export type * from './types';
export * from './classify';
export * from './display-order';
export * from './errors';
export * from './grouping';
export * from './open-turn';
export * from './parts';
export * from './peer-message-prompt';
export * from './segments';
export * from './session-report';
export * from './shell';
export * from './state';
export * from './subagent-notice';
export * from './tool-kind';
export * from './tool-registry';
export * from './tools';
export * from './view-model';
