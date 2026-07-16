'use client';

import { STATUS_BG, STATUS_BORDER, STATUS_TEXT } from '@/components/ui/status';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { cn } from '@/lib/utils';

export interface ValidationIssue {
  code: string;
  message: string;
  path: string[];
  values?: string[];
}

export function parseErrorContent(error: string): {
  summary: string;
  traceback: string | null;
  errorType: string | null;
  validationIssues: ValidationIssue[] | null;
} {
  const cleaned = error.replace(/^Error:\s*/, '');

  const trimmed = cleaned.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];

      if (
        arr.length > 0 &&
        arr.every((item: any) => item && typeof item === 'object' && 'message' in item)
      ) {
        const issues: ValidationIssue[] = arr.map((item: any) => ({
          code: item.code || 'error',
          message: item.message || String(item),
          path: Array.isArray(item.path) ? item.path.map(String) : [],
          values: Array.isArray(item.values) ? item.values.map(String) : undefined,
        }));

        const first = issues[0];
        const pathStr = first.path.length > 0 ? first.path.join('.') : '';
        const summary = pathStr ? `${pathStr}: ${first.message}` : first.message;
        return {
          summary,
          traceback: null,
          errorType: 'Validation Error',
          validationIssues: issues,
        };
      }
    } catch {}
  }

  const tracebackIdx = cleaned.indexOf('Traceback (most recent call last):');
  if (tracebackIdx >= 0) {
    const before = cleaned.slice(0, tracebackIdx).trim();
    const traceSection = cleaned.slice(tracebackIdx);

    const lines = traceSection.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1] || '';

    const typeMatch = lastLine.match(/^([\w._]+(?:Error|Exception|Warning)):\s*/);
    const errorType = typeMatch ? typeMatch[1].split('.').pop() || typeMatch[1] : null;
    const summary = before || (errorType ? lastLine : lastLine.slice(0, 120));
    return {
      summary,
      traceback: traceSection,
      errorType,
      validationIssues: null,
    };
  }

  const stackIdx = cleaned.indexOf('\n    at ');
  if (stackIdx >= 0) {
    const summary = cleaned.slice(0, stackIdx).trim();
    return {
      summary,
      traceback: cleaned.slice(stackIdx),
      errorType: null,
      validationIssues: null,
    };
  }

  const colonIdx = cleaned.indexOf(': ');
  if (colonIdx > 0 && colonIdx < 60) {
    const left = cleaned.slice(0, colonIdx);
    if (/^[\w._-]+$/.test(left)) {
      return {
        summary: cleaned,
        traceback: null,
        errorType: left,
        validationIssues: null,
      };
    }
  }

  return {
    summary: cleaned,
    traceback: null,
    errorType: null,
    validationIssues: null,
  };
}

export function parseExecutorOutput(output: string): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const v = JSON.parse(output);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function ExecutorRiskBadge({ risk }: { risk?: unknown }) {
  if (typeof risk !== 'string' || !risk) return null;
  const tint =
    risk === 'read'
      ? STATUS_TEXT.success
      : risk === 'destructive'
        ? STATUS_TEXT.destructive
        : STATUS_TEXT.warning;
  return (
    <span className={cn('flex-shrink-0 text-[10px] font-semibold tracking-wide uppercase', tint)}>
      {risk}
    </span>
  );
}

export function ExecutorJson({ value }: { value: unknown }) {
  if (value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)) {
    return <span className="text-muted-foreground/60 font-mono text-xs">{'{}'}</span>;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <OutputBlock text={text} />;
}
