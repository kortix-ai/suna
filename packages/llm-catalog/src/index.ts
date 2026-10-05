// The full surface: every helper (`./lite`) plus the bundled models.dev
// snapshot and its reader. Browser bundlers that tree-shake drop
// `catalog-data.ts` when `CATALOG` is unused; bundlers that do not (Metro)
// import `@kortix/llm-catalog/lite` instead.
export * from './lite';
export { CATALOG, catalogModelForWireModel } from './catalog-data';
