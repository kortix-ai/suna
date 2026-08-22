import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Modal } from '@/components/ui/modal';
import type { ConnectorGateConnection } from '@/stores/connector-gate-store';

import { ConnectorConnectionGateContent } from './connector-connection-gate-dialog';

const privateConnection: ConnectorGateConnection = {
  id: 'connection-private',
  slug: 'private-calendar',
  name: 'Private calendar',
  authorization_strategy: 'user',
};

const projectConnection: ConnectorGateConnection = {
  id: 'connection-project',
  slug: 'project-crm',
  name: 'Project CRM',
  authorization_strategy: 'project',
};

function renderGate({
  connectedIds = new Set<string>(),
  pendingId = null,
  canManageProjectConnections = true,
}: {
  connectedIds?: ReadonlySet<string>;
  pendingId?: string | null;
  canManageProjectConnections?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <Modal open>
      <ConnectorConnectionGateContent
        connections={[privateConnection, projectConnection]}
        connectedIds={connectedIds}
        pendingId={pendingId}
        canManageProjectConnections={canManageProjectConnections}
        onConnect={() => {}}
        onCancel={() => {}}
      />
    </Modal>,
  );
}

describe('ConnectorConnectionGateContent', () => {
  test('renders every required connection with its ownership strategy and connect action', () => {
    const html = renderGate();

    expect(html).toContain('This session needs 2 connections.');
    expect(html).toContain('Private calendar');
    expect(html).toContain('Project CRM');
    expect(html).toContain('Private');
    expect(html).toContain('Project');
    expect(html).toContain('Only your private sessions can use this connection.');
    expect(html).toContain('Eligible project members can use this connection.');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).toContain('aria-label="Connect Project CRM"');
  });

  test('requires a project manager for a project connection without management access', () => {
    const html = renderGate({ canManageProjectConnections: false });

    expect(html).toContain('A project manager must create this connection.');
    expect(html).toContain('Manager required');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).not.toContain('aria-label="Connect Project CRM"');
  });

  test('renders connected and pending connections without enabling another connect action', () => {
    const html = renderGate({
      connectedIds: new Set([projectConnection.id]),
      pendingId: privateConnection.id,
    });

    expect(html).toContain('Connected');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('animate-spinner-orbit');
    expect(html).not.toContain('aria-label="Connect Project CRM"');
  });
});
