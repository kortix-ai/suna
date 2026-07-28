/**
 * CodeMirror 6 extension for rendering LSP diagnostics as inline decorations.
 *
 * Features:
 *  - Squiggly underlines (red = error, yellow = warning, blue = info, grey = hint)
 *  - Gutter markers (colored dots matching severity)
 *  - Hover tooltips showing the diagnostic message
 *  - Full-line highlight for the first error/warning on each line
 *
 * Usage:
 *   import { diagnosticsExtension } from './codemirror-diagnostics';
 *   const ext = diagnosticsExtension(diagnostics);
 *   // pass `ext` in the CodeMirror `extensions` array
 */

import type { DiagnosticSeverity, LspDiagnostic } from '@/stores/diagnostics-store';
import { type Diagnostic as CmDiagnostic, linter } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';

// ============================================================================
// Severity mapping
// ============================================================================

function severityToAction(severity: DiagnosticSeverity): 'error' | 'warning' | 'info' {
  switch (severity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
    case 4:
    default:
      return 'info';
  }
}

// ============================================================================
// Build a CodeMirror linter from an array of LspDiagnostics
// ============================================================================

/**
 * Creates a CodeMirror extension that renders LSP diagnostics.
 *
 * Because diagnostics come from an external store (Zustand) and update
 * independently from document edits, we use a synchronous linter that
 * simply maps the latest diagnostics to CodeMirror positions.
 *
 * The caller should recreate this extension (or pass a new diagnostics
 * array) when the store changes — CodeMirror will diff extensions and
 * only recompute when needed.
 */
export function diagnosticsExtension(diagnostics: LspDiagnostic[]): Extension {
  if (!diagnostics || diagnostics.length === 0) {
    // Return a no-op linter so the lint gutter is still present
    // (avoids layout shift when diagnostics appear later)
    return linter(() => [], {
      delay: 0,
    });
  }

  return linter(
    (view) => {
      const doc = view.state.doc;
      const cmDiags: CmDiagnostic[] = [];

      for (const d of diagnostics) {
        // LSP lines/columns are 0-indexed, CodeMirror doc.line() is 1-indexed
        const lineNumber = d.line + 1;

        // Guard: skip diagnostics outside the document range
        if (lineNumber < 1 || lineNumber > doc.lines) continue;

        const line = doc.line(lineNumber);

        // Compute start position
        let from = line.from + Math.min(d.column, line.length);

        // Compute end position
        let to: number;
        if (d.endLine !== undefined && d.endColumn !== undefined) {
          const endLineNumber = d.endLine + 1;
          if (endLineNumber >= 1 && endLineNumber <= doc.lines) {
            const endLine = doc.line(endLineNumber);
            to = endLine.from + Math.min(d.endColumn, endLine.length);
          } else {
            to = line.to;
          }
        } else {
          // No end position: underline the rest of the line (from the start column),
          // or at least one character so the squiggle is visible
          to = line.to;
        }

        // Ensure from <= to and at least 1 char wide
        if (from > to) {
          [from, to] = [to, from];
        }
        if (from === to) {
          // Extend by one char if possible, otherwise extend backwards
          if (to < line.to) {
            to = to + 1;
          } else if (from > line.from) {
            from = from - 1;
          }
        }

        // Clamp to document bounds
        from = Math.max(0, Math.min(from, doc.length));
        to = Math.max(0, Math.min(to, doc.length));

        const severity = severityToAction(d.severity);
        const sourcePrefix = d.source ? `[${d.source}] ` : '';

        cmDiags.push({
          from,
          to,
          severity,
          message: `${sourcePrefix}${d.message}`,
          // Render a custom tooltip with better styling
          renderMessage() {
            const dom = document.createElement('div');
            dom.className = 'cm-lsp-diagnostic-tooltip';

            // Source badge
            if (d.source) {
              const badge = document.createElement('span');
              badge.className = 'cm-lsp-diagnostic-source';
              badge.textContent = d.source;
              dom.appendChild(badge);
            }

            // Message text
            const msg = document.createElement('span');
            msg.className = 'cm-lsp-diagnostic-message';
            msg.textContent = d.message;
            dom.appendChild(msg);

            return dom;
          },
        });
      }

      return cmDiags;
    },
    {
      // Re-lint immediately when the document or config changes
      delay: 0,
      // Show markers in the gutter
      markerFilter: undefined,
      // Keep tooltips on hover
      tooltipFilter: undefined,
    },
  );
}

// ============================================================================
// CSS styles for the diagnostic tooltips (injected once)
// ============================================================================

let stylesInjected = false;

export function injectDiagnosticStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    /* ---- LSP Diagnostic Tooltip ---- */
    .cm-lsp-diagnostic-tooltip {
      display: flex;
      align-items: baseline;
      gap: 6px;
      font-size: 12px;
      line-height: 1.4;
      max-width: 500px;
    }

    .cm-lsp-diagnostic-source {
      flex-shrink: 0;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      background: rgba(127, 127, 127, 0.15);
      color: rgba(180, 180, 180, 0.8);
    }

    .cm-lsp-diagnostic-message {
      word-break: break-word;
    }

    /* ---- Lint panel styling overrides ---- */
    .cm-panel.cm-panel-lint {
      background: var(--cm-backgroundColor, #1e1e1e);
      border-top: 1px solid rgba(127, 127, 127, 0.2);
    }

    /* ---- Make lint tooltip match our theme ---- */
    .cm-tooltip-lint {
      background: #1e1e1e !important;
      border: 1px solid rgba(127, 127, 127, 0.25) !important;
      border-radius: 6px !important;
      padding: 6px 10px !important;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3) !important;
    }

    /* Light theme overrides */
    [data-theme="light"] .cm-tooltip-lint,
    .light .cm-tooltip-lint {
      background: #ffffff !important;
      border-color: rgba(0, 0, 0, 0.12) !important;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08) !important;
    }

    [data-theme="light"] .cm-lsp-diagnostic-source,
    .light .cm-lsp-diagnostic-source {
      background: rgba(0, 0, 0, 0.06);
      color: rgba(0, 0, 0, 0.5);
    }

    /* ---- Gutter marker styling ---- */
    .cm-lint-marker {
      width: 8px !important;
      height: 8px !important;
    }

    /* ---- Subtle line background for diagnostic lines ---- */
    .cm-lintRange-error {
      background-image: none;
      background-color: transparent;
      text-decoration: wavy underline;
      text-decoration-color: #f44747;
      text-underline-offset: 3px;
      text-decoration-thickness: 1px;
    }

    .cm-lintRange-warning {
      background-image: none;
      background-color: transparent;
      text-decoration: wavy underline;
      text-decoration-color: #e5c07b;
      text-underline-offset: 3px;
      text-decoration-thickness: 1px;
    }

    .cm-lintRange-info {
      background-image: none;
      background-color: transparent;
      text-decoration: wavy underline;
      text-decoration-color: #4fc1ff;
      text-underline-offset: 3px;
      text-decoration-thickness: 1px;
    }

    /* Active (hovered) squiggle gets a subtle background */
    .cm-lintRange-active {
      background-color: rgba(255, 255, 255, 0.04);
    }

    [data-theme="light"] .cm-lintRange-active,
    .light .cm-lintRange-active {
      background-color: rgba(0, 0, 0, 0.03);
    }
  `;
  document.head.appendChild(style);
}
