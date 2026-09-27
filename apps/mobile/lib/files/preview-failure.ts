/**
 * Why a sandbox file did not load, in words a person can act on. The file hooks
 * (`lib/files/hooks.ts`) throw `Failed to … file: <status>`; a stopped sandbox
 * keeps its transcript but answers no file read, so "not reachable" is the
 * common case and the one worth a retry.
 */
export type PreviewFailureKind = 'missing' | 'denied' | 'unreachable';

export interface PreviewFailure {
  kind: PreviewFailureKind;
  /** HTTP status from the failed read, when the error carries one. */
  status: number | null;
  message: string;
  canRetry: boolean;
}

function statusOf(error: unknown): number | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = text.match(/\b([1-5]\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export function previewFailure(error: unknown, hasSandbox: boolean): PreviewFailure {
  if (!hasSandbox) {
    return {
      kind: 'unreachable',
      status: null,
      message: 'The sandbox is not connected. It may be asleep or starting up.',
      canRetry: true,
    };
  }

  const status = statusOf(error);
  if (status === 404) {
    return {
      kind: 'missing',
      status,
      message: 'This file is no longer in the sandbox. It was moved or deleted.',
      canRetry: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'denied',
      status,
      message: 'You do not have access to this file.',
      canRetry: false,
    };
  }
  return {
    kind: 'unreachable',
    status,
    message: 'The sandbox did not answer. It may be asleep or starting up.',
    canRetry: true,
  };
}
