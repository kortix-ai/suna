import type { ImagePullStatus, SandboxUpdateStatus } from './types';

// ─── Image-pull status (module-level single owner) ──────────────────────────

let _pullStatus: ImagePullStatus = { state: 'idle', progress: 0, message: '' };

export function getImagePullStatus(): ImagePullStatus {
  return { ..._pullStatus };
}

/** Replace the module-level image-pull status. Single mutation point. */
export function setPullStatus(status: ImagePullStatus): void {
  _pullStatus = status;
}

// ─── Sandbox-update status (module-level single owner) ──────────────────────

const IDLE_UPDATE_STATUS: SandboxUpdateStatus = {
  phase: 'idle',
  progress: 0,
  message: '',
  targetVersion: null,
  previousVersion: null,
  currentVersion: null,
  error: null,
  startedAt: null,
  updatedAt: null,
};

let _updateStatus: SandboxUpdateStatus = { ...IDLE_UPDATE_STATUS };

export function getSandboxUpdateStatus(): SandboxUpdateStatus {
  return { ..._updateStatus };
}

export function setUpdateStatus(partial: Partial<SandboxUpdateStatus>): void {
  _updateStatus = { ..._updateStatus, ...partial, updatedAt: new Date().toISOString() };
}
