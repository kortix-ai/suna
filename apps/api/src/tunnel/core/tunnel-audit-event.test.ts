import { expect, test } from 'bun:test';
import { tunnelCentralAuditEvent } from './tunnel-audit-event';
import { buildRequestSummary } from './audit-logger';

test('tunnelCentralAuditEvent excludes command arguments and file content', () => {
  const event = tunnelCentralAuditEvent({
    tunnelId: 'tunnel-1',
    accountId: 'account-1',
    actorUserId: 'actor-1',
    capability: 'shell',
    operation: 'shell.exec',
    requestSummary: {
      command: 'curl',
      args: ['-H', 'Authorization: Bearer secret'],
      content: 'secret file content',
    },
    success: true,
    durationMs: 42,
    bytesTransferred: 128,
  });

  expect(event).toMatchObject({
    accountId: 'account-1',
    actorUserId: 'actor-1',
    actorType: 'human',
    source: 'computer',
    outcome: 'success',
    action: 'computer.shell.exec',
    resourceType: 'computer_tunnel',
    resourceId: 'tunnel-1',
    durationMs: 42,
    metadata: {
      capability: 'shell',
      bytes_transferred: 128,
    },
  });
  expect(JSON.stringify(event)).not.toContain('Authorization');
  expect(JSON.stringify(event)).not.toContain('secret file content');
});

test('buildRequestSummary stores structure without command, arguments, paths, or content', () => {
  const summary = buildRequestSummary('shell.exec', {
    command: 'curl',
    args: ['-H', 'Authorization: Bearer private-credential'],
    cwd: '/workspace/private',
    path: '/workspace/private/token.txt',
    content: 'raw private file content',
    recursive: true,
    encoding: 'utf8',
  });

  expect(summary).toEqual({
    method: 'shell.exec',
    path: true,
    command: true,
    cwd: true,
    argumentCount: 2,
    recursive: true,
    encoding: 'utf8',
    contentSize: 24,
  });
  const wire = JSON.stringify(summary);
  expect(wire).not.toContain('curl');
  expect(wire).not.toContain('private-credential');
  expect(wire).not.toContain('/workspace/private');
  expect(wire).not.toContain('raw private file content');
});
