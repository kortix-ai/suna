import { expect, test } from 'bun:test';
import { tunnelCentralAuditEvent } from './tunnel-audit-event';

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
