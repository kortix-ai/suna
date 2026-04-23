export type UpdatePhase =
  | 'idle'
  | 'preflight'
  | 'pulling'
  | 'patching'
  | 'backing_up'
  | 'stopping'
  | 'removing'
  | 'recreating'
  | 'restarting'
  | 'verifying'
  | 'starting'
  | 'health_check'
  | 'complete'
  | 'failed';

export interface UpdateStatus {
  phase: UpdatePhase;
  progress: number;
  message: string;
  targetVersion: string | null;
  previousVersion: string | null;
  currentVersion: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  backupId: string | null;
  cancelRequested?: boolean;
  diagnostics?: Record<string, string | number | boolean | null>;
}

export const IDLE_STATUS: UpdateStatus = {
  phase: 'idle',
  progress: 0,
  message: '',
  targetVersion: null,
  previousVersion: null,
  currentVersion: null,
  error: null,
  startedAt: null,
  updatedAt: null,
  backupId: null,
  cancelRequested: false,
  diagnostics: {},
};

export type StepResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};
