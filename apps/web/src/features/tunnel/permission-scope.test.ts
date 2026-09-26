import { describe, expect, test } from 'bun:test';

// The same validator the API runs on `POST /tunnel/permission-requests/:id/approve`.
import { validateTunnelPermissionScope } from '../../../../../packages/agent-tunnel/src/shared/permissions';
import { approvalScope, scopeFromRequest } from './permission-scope';

// `requestedScope` exactly as the API writes it (`requestedScopeForOperation`
// in apps/api/src/tunnel/core/rpc-core.ts) and pushes it to the web over SSE.
const FILESYSTEM_WRITE = {
  capability: 'filesystem',
  requestedScope: { operations: ['write'], paths: ['/home/u/notes.txt'] },
};
const SHELL_WITH_CWD = {
  capability: 'shell',
  requestedScope: { commands: ['ls -la'], workingDir: '/home/u', maxTimeout: 30_000 },
};
const SHELL_WITHOUT_CWD = {
  capability: 'shell',
  requestedScope: { commands: ['git status'] },
};

function scopedApproval(request: { capability: string; requestedScope: Record<string, unknown> }) {
  return approvalScope(request.capability, scopeFromRequest(request));
}

describe('tunnel permission dialog — the recommended scoped approval', () => {
  test('a filesystem request pre-fills the requested path and operation', () => {
    expect(scopeFromRequest(FILESYSTEM_WRITE)).toEqual({
      paths: ['/home/u/notes.txt'],
      operations: ['write'],
      excludePatterns: [],
    });
  });

  test('a shell request pre-fills the full command, working directory and timeout', () => {
    expect(scopeFromRequest(SHELL_WITH_CWD)).toEqual({
      commands: ['ls -la'],
      workingDir: '/home/u',
      maxTimeout: 30_000,
    });
  });

  test('the filesystem approval body passes the server validator', () => {
    const body = scopedApproval(FILESYSTEM_WRITE);

    expect(body).toEqual({ paths: ['/home/u/notes.txt'], operations: ['write'] });
    expect(validateTunnelPermissionScope('filesystem', body)).toEqual({
      valid: true,
      sanitized: body,
    });
  });

  test('the shell approval body passes the server validator', () => {
    const body = scopedApproval(SHELL_WITH_CWD);

    expect(validateTunnelPermissionScope('shell', body).valid).toBe(true);
  });

  test('a shell request without a working directory sends none, never an empty string', () => {
    const body = scopedApproval(SHELL_WITHOUT_CWD);

    expect(body).toEqual({ commands: ['git status'] });
    expect(validateTunnelPermissionScope('shell', body).valid).toBe(true);
  });

  test('a cleared path list is still sent, so the server refuses it instead of widening it', () => {
    const body = approvalScope('filesystem', {
      paths: [],
      operations: ['read'],
      excludePatterns: [],
    });

    expect(body).toEqual({ paths: [], operations: ['read'] });
    expect(validateTunnelPermissionScope('filesystem', body).valid).toBe(false);
  });
});
