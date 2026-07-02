import { expect, test } from 'bun:test';
import * as platformClient from './index';

const EXPECTED_FUNCTIONS = [
  'getSandboxUrl',
  'getSandboxPortUrl',
  'getProviders',
  'ensureSandbox',
  'getSandbox',
  'createSandbox',
  'getSandboxById',
  'renameSandbox',
  'listSandboxes',
  'discoverLocalSandbox',
  'restartSandbox',
  'stopSandbox',
  'cancelSandbox',
  'reactivateSandbox',
  'listSandboxMembers',
  'addSandboxMember',
  'removeSandboxMember',
  'updateSandboxMemberRole',
  'updateSandboxMemberSpendCap',
  'getViewerSandboxScopes',
  'getSandboxMemberScopes',
  'updateSandboxMemberScope',
  'listSandboxProjectMembers',
  'grantSandboxProjectAccess',
  'revokeSandboxProjectAccess',
  'revokeSandboxInvite',
  'getInvite',
  'acceptInvite',
  'declineInvite',
  'listBackups',
  'createBackup',
  'restoreBackup',
  'deleteBackup',
  'setupSSH',
  'getSSHConnection',
  'isDestructivePhase',
  'getSandboxUpdateStatus',
  'getLatestSandboxVersion',
  'getFullChangelog',
  'getAllVersions',
  'triggerSandboxUpdate',
  'resetSandboxUpdateStatus',
  'cancelSandboxUpdate',
] as const;

test('platform-client barrel exports the full function surface', () => {
  for (const name of EXPECTED_FUNCTIONS) {
    expect(typeof (platformClient as Record<string, unknown>)[name]).toBe('function');
  }
});

test('platform-client barrel exports the canonical SANDBOX_PORTS', () => {
  expect(platformClient.SANDBOX_PORTS).toEqual({
    DESKTOP: '6080',
    DESKTOP_HTTPS: '6081',
    PRESENTATION_VIEWER: '3210',
    STATIC_FILE_SERVER: '3211',
    KORTIX_MASTER: '8000',
    BROWSER_STREAM: '9223',
    BROWSER_VIEWER: '9224',
    SSH: '22',
  });
});

test('platform-client barrel exports DESTRUCTIVE_PHASES', () => {
  expect(Array.isArray(platformClient.DESTRUCTIVE_PHASES)).toBe(true);
  expect(platformClient.DESTRUCTIVE_PHASES).toContain('pulling');
});

test('shared internals stay off the public surface', () => {
  const surface = platformClient as Record<string, unknown>;
  expect(surface.platformFetch).toBeUndefined();
  expect(surface.findProjectSessionSandbox).toBeUndefined();
  expect(surface.listProjectSessionSandboxes).toBeUndefined();
});
