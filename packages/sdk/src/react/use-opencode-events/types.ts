// `OpenCodeEvent`'s canonical definition now lives in the framework-free
// `state/event-stream.ts` (the extracted SSE machine dispatches this type).
// Re-exported here, unchanged, so existing importers in this directory don't
// need to change their import path.
export type { OpenCodeEvent } from '../../state/event-stream';
