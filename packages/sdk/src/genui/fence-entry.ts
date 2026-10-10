// `@kortix/sdk/genui/fence`: fence detection only. Must never reach `@openuidev/*` or `zod`
// (fence-entry.test.ts), so a markdown renderer can check a fence without loading the parser.
export { genuiVersionFromClassName, genuiVersionOf, separateGenuiClosers, splitGenui } from './fence';
export type { GenuiSegment } from './types';
