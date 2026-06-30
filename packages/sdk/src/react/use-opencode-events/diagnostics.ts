import type { Part } from '@opencode-ai/sdk/v2/client';
import type { RefObject } from 'react';
import { parseDiagnosticsFromToolOutput, useDiagnosticsStore } from '../../state/diagnostics-store';

/**
 * Extract diagnostics carried by a `message.part.updated` part — both the
 * primary tool-output text path and the legacy `metadata.diagnostics` fallback —
 * and push them into the diagnostics store. Paths are normalized from absolute
 * sandbox paths to project-relative via the supplied ref.
 */
export function applyPartDiagnostics(
  part: Part,
  normalizeDiagnosticPaths: RefObject<
    (diagsByFile: Record<string, any[]>) => Record<string, any[]>
  >,
): void {
  const partState = (part as any)?.state;

  // --- Primary path: parse diagnostics from tool output text ---
  // The OpenCode backend embeds diagnostics as plain text inside
  // <file_diagnostics> / <project_diagnostics> XML tags in the
  // tool's text output (e.g. after write, edit, diagnostics tools).
  if (partState?.status === 'completed' && partState.output) {
    const output = partState.output as string;
    if (output.includes('<file_diagnostics>') || output.includes('<project_diagnostics>')) {
      const parsed = parseDiagnosticsFromToolOutput(output);
      const fileCount = Object.keys(parsed).length;
      if (fileCount > 0) {
        // Normalize absolute sandbox paths to project-relative
        const normalized = normalizeDiagnosticPaths.current(parsed);
        // Convert LspDiagnostic[] to RawDiagnostic[] format for the store
        const asRaw: Record<string, any[]> = {};
        for (const [file, diags] of Object.entries(normalized)) {
          asRaw[file] = diags.map((d) => ({
            range: {
              start: { line: d.line, character: d.column },
            },
            severity: d.severity,
            message: d.message,
            source: d.source,
          }));
        }
        useDiagnosticsStore.getState().setFromLspEvent(asRaw);
      }
    }
  }

  // --- Fallback: check metadata.diagnostics (legacy / fork path) ---
  const partMeta = partState?.metadata;
  if (partMeta?.diagnostics && typeof partMeta.diagnostics === 'object') {
    const diagsByFile = partMeta.diagnostics as Record<string, any[]>;
    const validEntries: Record<string, any[]> = {};
    let hasValid = false;
    for (const [file, diags] of Object.entries(diagsByFile)) {
      if (Array.isArray(diags) && diags.length > 0) {
        validEntries[file] = diags;
        hasValid = true;
      }
    }
    if (hasValid) {
      const normalized = normalizeDiagnosticPaths.current(validEntries);
      useDiagnosticsStore.getState().setFromLspEvent(normalized);
    }
  }
}
