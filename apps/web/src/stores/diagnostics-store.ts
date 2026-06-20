'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================================================
// Types
// ============================================================================

export type DiagnosticSeverity = 1 | 2 | 3 | 4; // Error, Warning, Info, Hint

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
}

export interface DiagnosticsState {
  /** All diagnostics keyed by file path (may be absolute or relative) */
  byFile: Record<string, LspDiagnostic[]>;

  // ---- Actions ----

  /** Set all diagnostics for a given file (replaces existing) */
  setFileDiagnostics: (file: string, diagnostics: LspDiagnostic[]) => void;

  /** Bulk-set diagnostics from an lsp.updated event payload (Record<string, RawDiag[]>) */
  setFromLspEvent: (diagnosticsByFile: Record<string, RawDiagnostic[]>) => void;

  /** Clear diagnostics for a file */
  clearFile: (file: string) => void;

  /** Clear all diagnostics */
  clearAll: () => void;

  // ---- Derived ----

  /** Total error count (severity 1) */
  getErrorCount: () => number;

  /** Total warning count (severity 2) */
  getWarningCount: () => number;

  /** Get all diagnostics across all files, sorted by severity then file */
  getAllDiagnostics: () => LspDiagnostic[];
}

/**
 * Raw diagnostic shape from LSP / tool metadata.
 * Supports both the range-based format (from tool metadata) and flat format.
 */
export interface RawDiagnostic {
  range?: {
    start: { line: number; character: number };
    end?: { line: number; character: number };
  };
  line?: number;
  column?: number;
  character?: number;
  endLine?: number;
  endColumn?: number;
  severity?: number;
  message: string;
  source?: string;
}

// ============================================================================
// Path matching helpers
// ============================================================================

/**
 * Find diagnostics for a file using flexible path matching.
 *
 * LSP servers store diagnostics keyed by absolute sandbox paths (e.g.
 * `/workspace/desktop/express-crud-app/src/server.js`), but the frontend
 * uses project-relative paths (e.g. `src/server.js`). This function
 * handles the mismatch by:
 *
 *  1. Exact match (covers relative-to-relative)
 *  2. The store key ends with `/<relativePath>` (abs→rel match)
 *  3. The lookup path ends with `/<storeKey>` (rel→abs, unlikely but safe)
 */
export function findDiagnosticsForFile(
  byFile: Record<string, LspDiagnostic[]>,
  filePath: string,
): LspDiagnostic[] | undefined {
  // 1. Exact match
  if (byFile[filePath]) return byFile[filePath];

  // Normalise: strip leading slashes and any `file://` prefix for comparison
  const cleanPath = filePath.replace(/^file:\/\//, '').replace(/^\/+/, '');

  // 2. Store key ends with the relative path
  for (const key of Object.keys(byFile)) {
    const cleanKey = key.replace(/^file:\/\//, '').replace(/^\/+/, '');

    // Exact after normalisation
    if (cleanKey === cleanPath) return byFile[key];

    // Store key is absolute, lookup path is relative
    if (cleanKey.endsWith('/' + cleanPath)) return byFile[key];

    // Lookup path is absolute, store key is relative (rare)
    if (cleanPath.endsWith('/' + cleanKey)) return byFile[key];
  }

  return undefined;
}

/**
 * Build a map from relative file path → { errors, warnings } by iterating
 * the diagnostics store. Uses the last N segments of each store key so that
 * both `sidebar-explorer` (uses `node.path` which is relative) and
 * `file-browser` can compute diagnostic counts.
 *
 * Returns a map where keys are every possible suffix of the store keys
 * (e.g. for `/workspace/project/src/app.ts` it includes entries for
 * `src/app.ts`, `project/src/app.ts`, `app.ts`, etc.) This is O(totalKeys * avgDepth)
 * but in practice the number of files with diagnostics is small.
 */
export function buildDiagnosticCountsMap(
  byFile: Record<string, LspDiagnostic[]>,
): Record<string, { errors: number; warnings: number }> {
  const map: Record<string, { errors: number; warnings: number }> = {};

  for (const [key, diags] of Object.entries(byFile)) {
    if (!diags || diags.length === 0) continue;

    let errors = 0;
    let warnings = 0;
    for (const d of diags) {
      if (d.severity === 1) errors++;
      else if (d.severity === 2) warnings++;
    }
    if (errors === 0 && warnings === 0) continue;

    const counts = { errors, warnings };

    // Register under every suffix of the path so both absolute and
    // relative lookups work.
    const cleanKey = key.replace(/^file:\/\//, '');
    const parts = cleanKey.split('/').filter(Boolean);

    // Full path (with leading slash removed)
    map[parts.join('/')] = counts;

    // Also register with leading slash for absolute lookups
    if (cleanKey.startsWith('/')) {
      map[cleanKey] = counts;
    }

    // Progressive suffixes: src/app.ts, app.ts
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      // Don't overwrite — first match (longest key) wins
      if (!map[suffix]) {
        map[suffix] = counts;
      }
    }
  }

  return map;
}

/**
 * Extract the relative filename from a diagnostic's file path.
 * Used by the diagnostics panel to show short names.
 */
export function getRelativePath(absPath: string): string {
  const clean = absPath.replace(/^file:\/\//, '');
  // If it looks absolute, try common sandbox prefixes
  if (clean.startsWith('/')) {
    // Strip /workspace/desktop/.../ or /home/user/project/.../ patterns
    // Strategy: find the deepest "project root" heuristic and strip it
    // Common patterns: /workspace/X/Y/ where Y is the project
    const parts = clean.split('/').filter(Boolean);
    // Look for common project markers going from right to left
    for (let i = 0; i < parts.length; i++) {
      if (['src', 'lib', 'app', 'pages', 'components', 'public', 'test', 'tests', 'pkg', 'cmd', 'internal'].includes(parts[i])) {
        return parts.slice(i).join('/');
      }
    }
    // If no marker found, take the last 3 segments max
    if (parts.length > 3) {
      return parts.slice(-3).join('/');
    }
    return parts.join('/');
  }
  return clean;
}

// ============================================================================
// Parse diagnostics from tool output text
// ============================================================================

/**
 * Parse diagnostics from OpenCode tool output text.
 *
 * The Go backend embeds diagnostics as plain text in `<file_diagnostics>`
 * and `<project_diagnostics>` XML tags within the tool result. Each line
 * follows the format:
 *
 *   Severity: /path/to/file.ts:line:col [source][code] (tags) message
 *
 * Examples:
 *   Error: /workspace/src/server.js:4:1 [typescript] Cannot find module './utils/nonexistent'
 *   Warn: /workspace/src/server.js:5:7 [typescript][6133] (unnecessary) 'unused_import' is declared but never read
 */
export function parseDiagnosticsFromToolOutput(
  output: string,
): Record<string, LspDiagnostic[]> {
  const result: Record<string, LspDiagnostic[]> = {};

  // Extract content from both tag types
  const tagPattern = /<(?:file_diagnostics|project_diagnostics)>([\s\S]*?)<\/(?:file_diagnostics|project_diagnostics)>/g;
  let tagMatch;
  const allLines: string[] = [];

  while ((tagMatch = tagPattern.exec(output)) !== null) {
    const content = tagMatch[1].trim();
    if (content) {
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('...')) {
          allLines.push(trimmed);
        }
      }
    }
  }

  if (allLines.length === 0) return result;

  // Parse each diagnostic line
  // Format: Severity: /path/to/file:line:col [source][code] (tags) message
  const linePattern = /^(Error|Warn|Info|Hint):\s+(.+?):(\d+):(\d+)\s+\[([^\]]*)\](.*)$/;

  for (const line of allLines) {
    const match = linePattern.exec(line);
    if (!match) continue;

    const [, severityStr, filePath, lineStr, colStr, source, rest] = match;

    const severity: DiagnosticSeverity =
      severityStr === 'Error' ? 1 :
      severityStr === 'Warn' ? 2 :
      severityStr === 'Hint' ? 4 : 3;

    // Parse optional [code] and message from the rest
    // rest might be: [6133] (unnecessary) message text
    //            or: message text
    let message = rest.trim();
    // Strip optional [code] prefix
    message = message.replace(/^\[\w+\]\s*/, '');
    // Strip optional (tags) prefix
    message = message.replace(/^\([^)]*\)\s*/, '');

    const lineNum = parseInt(lineStr, 10) - 1; // Convert to 0-indexed
    const colNum = parseInt(colStr, 10) - 1;

    const diag: LspDiagnostic = {
      file: filePath,
      line: Math.max(0, lineNum),
      column: Math.max(0, colNum),
      severity,
      message: message || `${severityStr} at ${lineStr}:${colStr}`,
      source: source || undefined,
    };

    if (!result[filePath]) {
      result[filePath] = [];
    }
    result[filePath].push(diag);
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeRawDiagnostic(file: string, raw: RawDiagnostic): LspDiagnostic {
  const line = raw.range?.start?.line ?? raw.line ?? 0;
  const column = raw.range?.start?.character ?? raw.column ?? raw.character ?? 0;
  const endLine = raw.range?.end?.line ?? raw.endLine;
  const endColumn = raw.range?.end?.character ?? raw.endColumn;
  const severity = (raw.severity ?? 1) as DiagnosticSeverity;

  return {
    file,
    line,
    column,
    endLine,
    endColumn,
    severity,
    message: raw.message,
    source: raw.source,
  };
}

// ============================================================================
// Store
// ============================================================================

export const useDiagnosticsStore = create<DiagnosticsState>()(
  persist(
  (set, get) => ({
  byFile: {},

  setFileDiagnostics: (file, diagnostics) =>
    set((state) => ({
      byFile: {
        ...state.byFile,
        [file]: diagnostics,
      },
    })),

  setFromLspEvent: (diagnosticsByFile) =>
    set((state) => {
      const next = { ...state.byFile };
      for (const [file, rawDiags] of Object.entries(diagnosticsByFile)) {
        if (!Array.isArray(rawDiags)) continue;
        const normalized = rawDiags.map((d) => normalizeRawDiagnostic(file, d));
        if (normalized.length === 0) {
          delete next[file];
        } else {
          next[file] = normalized;
        }
      }
      return { byFile: next };
    }),

  clearFile: (file) =>
    set((state) => {
      const { [file]: _, ...rest } = state.byFile;
      return { byFile: rest };
    }),

  clearAll: () => set({ byFile: {} }),

  getErrorCount: () => {
    const { byFile } = get();
    let count = 0;
    for (const diags of Object.values(byFile)) {
      for (const d of diags) {
        if (d.severity === 1) count++;
      }
    }
    return count;
  },

  getWarningCount: () => {
    const { byFile } = get();
    let count = 0;
    for (const diags of Object.values(byFile)) {
      for (const d of diags) {
        if (d.severity === 2) count++;
      }
    }
    return count;
  },

  getAllDiagnostics: () => {
    const { byFile } = get();
    const all: LspDiagnostic[] = [];
    for (const diags of Object.values(byFile)) {
      all.push(...diags);
    }
    // Sort: errors first, then warnings, then by file, then by line
    all.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity - b.severity;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });
    return all;
  },
}),
  {
    name: 'kortix-diagnostics',
    storage: {
      getItem: (name) => {
        if (typeof window === 'undefined') return null;
        const str = sessionStorage.getItem(name);
        return str ? JSON.parse(str) : null;
      },
      setItem: (name, value) => {
        if (typeof window === 'undefined') return;
        sessionStorage.setItem(name, JSON.stringify(value));
      },
      removeItem: (name) => {
        if (typeof window === 'undefined') return;
        sessionStorage.removeItem(name);
      },
    },
    partialize: (state) => ({ byFile: state.byFile }) as unknown as DiagnosticsState,
  },
));

// Expose on window for console debugging
if (typeof window !== 'undefined') {
  (window as any).__diagStore = useDiagnosticsStore;
}
