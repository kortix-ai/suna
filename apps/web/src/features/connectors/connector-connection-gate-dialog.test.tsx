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

const workspaceConnection: ConnectorGateConnection = {
  id: 'connection-workspace',
  slug: 'workspace-crm',
  name: 'Workspace CRM',
  authorization_strategy: 'workspace',
};

function renderGate({
  connectedIds = new Set<string>(),
  pendingId = null,
  canManageWorkspaceConnections = true,
}: {
  connectedIds?: ReadonlySet<string>;
  pendingId?: string | null;
  canManageWorkspaceConnections?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <Modal open>
      <ConnectorConnectionGateContent
        connections={[privateConnection, workspaceConnection]}
        connectedIds={connectedIds}
        pendingId={pendingId}
        canManageWorkspaceConnections={canManageWorkspaceConnections}
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
    expect(html).toContain('Workspace CRM');
    expect(html).toContain('Private');
    expect(html).toContain('Workspace');
    expect(html).toContain('Only your private sessions can use this connection.');
    expect(html).toContain('Eligible workspace members can use this connection.');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).toContain('aria-label="Connect Workspace CRM"');
  });

  test('requires a workspace manager for a workspace connection without management access', () => {
    const html = renderGate({ canManageWorkspaceConnections: false });

    expect(html).toContain('A workspace manager must create this connection.');
    expect(html).toContain('Manager required');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).not.toContain('aria-label="Connect Workspace CRM"');
  });

  test('renders connected and pending connections without enabling another connect action', () => {
    const html = renderGate({
      connectedIds: new Set([workspaceConnection.id]),
      pendingId: privateConnection.id,
    });

    expect(html).toContain('Connected');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('animate-spinner-orbit');
    expect(html).not.toContain('aria-label="Connect Workspace CRM"');
  });
});
