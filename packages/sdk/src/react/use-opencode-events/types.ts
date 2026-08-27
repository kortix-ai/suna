// `OpenCodeEvent`'s canonical definition lives in the framework-free
// `core/stream/session-stream-controller.ts` (the session stream dispatches
// this type on its runtime channel). Re-exported here, unchanged, so existing
// importers in this directory don't need to change their import path.
export type { OpenCodeEvent } from '../../core/stream/session-stream-controller';

/**
 * A file-path-keyed diagnostics normalizer: remaps absolute sandbox paths to
 * project-relative ones without touching the diagnostic entries themselves.
 * Generic because callers pass different diagnostic element shapes (parsed
 * `LspDiagnostic[]`, raw `/lsp/diagnostics` payloads, legacy metadata blobs) —
 * the normalizer never reads their fields, only the outer file-path keys.
 */
export type NormalizeDiagnosticPaths = <T>(diagsByFile: Record<string, T[]>) => Record<string, T[]>;
