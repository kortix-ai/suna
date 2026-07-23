/**
 * Turn grouping & part helpers — framework-agnostic. See the individual
 * modules for implementation: `parts.ts`, `grouping.ts`, `shell.ts`, `state.ts`.
 *
 * `classify.ts`, `view-model.ts`, and `tool-registry.ts` are `@deprecated` —
 * part of the OpenCode-wire projection stack superseded by the ACP
 * projection layer (`../acp/transcript.ts` + `../acp/reduce.ts`). See their
 * module docs. Kept working, not removed; frozen by
 * `../../transcript.golden.test.ts`.
 */
export type * from './types';
export * from './classify';
export * from './errors';
export * from './grouping';
export * from './parts';
export * from './shell';
export * from './state';
export * from './tool-registry';
export * from './view-model';
