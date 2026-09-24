/**
 * Pure parsers the shared tool primitives render from.
 *
 * Each block is a port of an apps/web module, with the same exported names and
 * semantics, so a renderer ported from web keeps its parser calls:
 * - `lib/utils/structured-output.ts` → `normalizeToolOutput`,
 *   `hasStructuredContent`, `parseStructuredOutput`, `OutputSection`;
 * - `tool/shared/file-list.tsx` → `parseFilePaths`, `parseGrepOutput`;
 * - `tool/shared/todo-helpers.tsx` → `parseTodos`, `TodoItem`;
 * - `tool/shared/session-helpers.tsx` → `formatBashOutput`,
 *   `parseSessionMetadataOutput`, `parseSessionMessagesOutput`,
 *   `formatSessionTime`, `formatSessionTimeFallback`;
 * - `tool/shared/error-and-connector.tsx` → `parseConnectorOutput`;
 * - `@kortix/sdk` browser `diagnostics-store.ts` →
 *   `parseDiagnosticsFromToolOutput` (the store is zustand + browser-only, so
 *   it is not on the SDK root), and web `getToolDiagnostics`' body as
 *   `getToolDiagnosticsFrom(output, metadata, filePath)`.
 */

import { getDiagnostics, type Diagnostic } from '@kortix/sdk';

// ─── Structured output ───────────────────────────────────────────────────────

export type OutputSection =
  | { type: 'warning'; text: string }
  | { type: 'error'; summary: string; errorType: string | null }
  | { type: 'traceback'; lines: string[] }
  | { type: 'info'; text: string }
  | { type: 'install'; text: string }
  | { type: 'plain'; text: string };

/** Re-inserts newlines before known markers in output that lost them. */
export function normalizeToolOutput(raw: string): string {
  let text = raw.replace(/\^+\[[\d;]*[A-Za-z]/g, '');
  text = text.replace(/\^{3,}/g, ' ');

  const lineCount = text.split('\n').length;
  if (lineCount > 5) return text;

  text = text
    .replace(/(\S)\s*(warning:\s)/gi, '$1\n$2')
    .replace(/(\S)\s*(Traceback \(most recent call last\):)/g, '$1\n$2')
    .replace(/(\S)\s*(File ")/g, '$1\n$2')
    .replace(/(\S)\s*(Installed \d+ packages?\b)/gi, '$1\n$2')
    .replace(/(\S)\s*(Using (?:CPython|Python|Node|npm)\b)/gi, '$1\n$2')
    .replace(/(\S)\s*(Creating virtual environment\b)/gi, '$1\n$2')
    .replace(/(\S)\s*(raise\s+\w)/g, '$1\n$2')
    .replace(/(\))\s*(File ")/g, '$1\n$2');

  return text;
}

export function hasStructuredContent(output: string): boolean {
  return (
    (/warning:/i.test(output) && /Traceback|Installed|Using|Creating|Error:/i.test(output)) ||
    /Traceback \(most recent call last\):/i.test(output)
  );
}

/** Splits log-like output into typed sections. Call `normalizeToolOutput` first. */
export function parseStructuredOutput(raw: string): OutputSection[] {
  const sections: OutputSection[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (!trimmed) {
      i++;
      continue;
    }

    if (/^warning:/i.test(trimmed)) {
      let warningText = trimmed;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const nextTrimmed = next.trimStart();
        if (
          nextTrimmed &&
          !/^warning:/i.test(nextTrimmed) &&
          !/^(Traceback|Installed|Using|Creating|Error:|File ")/i.test(nextTrimmed) &&
          (next.startsWith('  ') || next.startsWith('\t') || /^[a-z]/.test(nextTrimmed))
        ) {
          warningText += ' ' + nextTrimmed;
          i++;
        } else {
          break;
        }
      }
      sections.push({ type: 'warning', text: warningText.replace(/^warning:\s*/i, '') });
      continue;
    }

    if (trimmed === 'Traceback (most recent call last):') {
      const traceLines: string[] = [trimmed];
      i++;
      while (i < lines.length) {
        const tl = lines[i];
        const tlTrimmed = tl.trimStart();
        traceLines.push(tl);
        i++;
        if (
          tlTrimmed &&
          !tl.startsWith(' ') &&
          !tl.startsWith('\t') &&
          tlTrimmed !== 'Traceback (most recent call last):'
        ) {
          while (i < lines.length && lines[i] && (lines[i].startsWith(' ') || lines[i].startsWith('\t'))) {
            traceLines.push(lines[i]);
            i++;
          }
          break;
        }
      }

      const lastLine = traceLines[traceLines.length - 1]?.trim() || '';
      const typeMatch = lastLine.match(/^([\w._]+(?:Error|Exception|Warning)):\s*(.*)/);
      const errorType = typeMatch ? typeMatch[1].split('.').pop() || typeMatch[1] : null;
      const errorSummary = typeMatch ? typeMatch[2] || lastLine : lastLine;

      sections.push({ type: 'traceback', lines: traceLines });
      sections.push({ type: 'error', summary: errorSummary, errorType });
      continue;
    }

    if (/^Installed \d+ packages?\b/i.test(trimmed)) {
      sections.push({ type: 'install', text: trimmed });
      i++;
      continue;
    }

    if (/^(Using|Creating) /i.test(trimmed)) {
      sections.push({ type: 'info', text: trimmed });
      i++;
      continue;
    }

    const plainLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const nextTrimmed = next.trimStart();
      if (!nextTrimmed || /^(warning:|Traceback|Installed|Using|Creating|Error:)/i.test(nextTrimmed)) {
        break;
      }
      plainLines.push(next);
      i++;
    }
    sections.push({ type: 'plain', text: plainLines.join('\n') });
  }

  return sections;
}

// ─── File lists ──────────────────────────────────────────────────────────────

export function parseFilePaths(output: string): string[] | null {
  if (!output) return null;
  const lines = output
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const pathLike = lines.filter((l) => l.startsWith('/') || l.startsWith('./') || l.startsWith('~'));
  if (pathLike.length >= lines.length * 0.7) return pathLike;
  return null;
}

export { type GrepFileGroup, type GrepMatch, parseGrepOutput } from '@kortix/shared/tool-output';

// ─── Todos ───────────────────────────────────────────────────────────────────

export interface TodoItem {
  content: string;
  status: 'completed' | 'in_progress' | 'pending' | 'cancelled';
  priority?: string;
}

export function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const content = record.content;
    if (typeof content !== 'string' || !content.trim()) return [];
    const s = record.status;
    const status: TodoItem['status'] =
      s === 'completed' || s === 'in_progress' || s === 'cancelled' ? s : 'pending';
    return [{ content, status, priority: record.priority as string | undefined }];
  });
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export function formatBashOutput(rawOutput: string): { content: string; lang: string } {
  const trimmed = rawOutput.trim();
  if (!trimmed) return { content: '', lang: 'bash' };

  try {
    const parsed = JSON.parse(trimmed);
    return { content: JSON.stringify(parsed, null, 2), lang: 'json' };
  } catch {}

  if (trimmed.includes('===') && trimmed.includes('{')) {
    const sections = trimmed.split(/^(={2,}\s.*)/m);
    let hasJson = false;
    const formatted = sections
      .flatMap((section) => {
        const st = section.trim();
        if (!st) return [];
        if (/^={2,}\s/.test(st)) return [st];
        try {
          const parsed = JSON.parse(st);
          hasJson = true;
          return [JSON.stringify(parsed, null, 2)];
        } catch {
          return [st];
        }
      })
      .join('\n\n');
    if (hasJson) return { content: formatted, lang: 'json' };
  }

  return { content: trimmed, lang: 'bash' };
}

export { type ParsedSessionMeta, parseSessionMetadataOutput } from '@kortix/shared/tool-output';

export function formatSessionTime(timestamp: number): string {
  const d = new Date(timestamp);
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const sessionTimeFallbackFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatSessionTimeFallback(timestamp: number): string {
  return sessionTimeFallbackFormat.format(new Date(timestamp));
}

export { type ParsedSessionMessage, parseSessionMessagesOutput } from '@kortix/shared/tool-output';

// ─── Connectors ──────────────────────────────────────────────────────────────

export function parseConnectorOutput(output: string): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const v = JSON.parse(output);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export type DiagnosticSeverity = 1 | 2 | 3 | 4;

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

/** `<file_diagnostics>` / `<project_diagnostics>` blocks → diagnostics by file (0-indexed). */
export function parseDiagnosticsFromToolOutput(output: string): Record<string, LspDiagnostic[]> {
  const result: Record<string, LspDiagnostic[]> = {};
  const tagPattern =
    /<(?:file_diagnostics|project_diagnostics)>([\s\S]*?)<\/(?:file_diagnostics|project_diagnostics)>/g;
  const allLines: string[] = [];
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagPattern.exec(output)) !== null) {
    const content = tagMatch[1].trim();
    if (!content) continue;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('...')) allLines.push(trimmed);
    }
  }
  if (allLines.length === 0) return result;

  const linePattern = /^(Error|Warn|Info|Hint):\s+(.+?):(\d+):(\d+)\s+\[([^\]]*)\](.*)$/;
  for (const line of allLines) {
    const match = linePattern.exec(line);
    if (!match) continue;
    const [, severityStr, filePath, lineStr, colStr, source, rest] = match;
    const severity: DiagnosticSeverity =
      severityStr === 'Error' ? 1 : severityStr === 'Warn' ? 2 : severityStr === 'Hint' ? 4 : 3;

    let message = rest.trim();
    message = message.replace(/^\[\w+\]\s*/, '');
    message = message.replace(/^\([^)]*\)\s*/, '');

    const diag: LspDiagnostic = {
      file: filePath,
      line: Math.max(0, parseInt(lineStr, 10) - 1),
      column: Math.max(0, parseInt(colStr, 10) - 1),
      severity,
      message: message || `${severityStr} at ${lineStr}:${colStr}`,
      source: source || undefined,
    };
    (result[filePath] ??= []).push(diag);
  }
  return result;
}

/**
 * Web `getToolDiagnostics(part, filePath)` over already-read output and
 * metadata: LSP diagnostics from the output (errors + warnings, max 5) when
 * present, else the metadata's per-file diagnostics (errors, max 3).
 */
export function getToolDiagnosticsFrom(
  output: string,
  metadata: Record<string, unknown>,
  filePath: string | undefined,
): Diagnostic[] {
  if (!filePath) return [];

  if (output && (output.includes('<file_diagnostics>') || output.includes('<project_diagnostics>'))) {
    const parsed = parseDiagnosticsFromToolOutput(output);
    let diags: LspDiagnostic[] | undefined;
    for (const [key, value] of Object.entries(parsed)) {
      if (key === filePath || key.endsWith('/' + filePath) || filePath.endsWith('/' + key)) {
        diags = value;
        break;
      }
    }
    if (!diags) diags = Object.values(parsed).flat();
    if (diags.length > 0) {
      return diags
        .filter((d) => d.severity === 1 || d.severity === 2)
        .slice(0, 5)
        .map((d) => ({
          range: {
            start: { line: d.line, character: d.column },
            end: { line: d.endLine ?? d.line, character: d.endColumn ?? d.column },
          },
          message: d.message,
          severity: d.severity,
        }));
    }
  }

  return getDiagnostics(metadata.diagnostics as Record<string, Diagnostic[]> | undefined, filePath);
}
