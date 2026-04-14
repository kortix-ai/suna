export type UpdatePhase =
  | 'idle'
  | 'pulling'
  | 'patching'
  | 'backing_up'
  | 'stopping'
  | 'restarting'
  | 'verifying'
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
};

export type StepResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};
