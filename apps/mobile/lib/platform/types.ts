/** Harness-neutral session list types consumed by mobile navigation/input. */

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export type Session = import('@kortix/sdk').Session;

export type SessionStatus = 'idle' | 'running' | 'error';

export interface SessionStatusMap {
  [sessionId: string]: SessionStatus;
}
