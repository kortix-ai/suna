import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Modal } from '@/components/ui/modal';
import type { ConnectorGateProfile } from '@/stores/connector-gate-store';

import { ConnectorAuthorizationGateContent } from './connector-connection-gate-dialog';

const privateProfile: ConnectorGateProfile = {
  id: 'profile-private',
  slug: 'private-calendar',
  name: 'Private calendar',
  authorization_strategy: 'user',
};

const projectProfile: ConnectorGateProfile = {
  id: 'profile-project',
  slug: 'project-crm',
  name: 'Project CRM',
  authorization_strategy: 'project',
};

function renderGate({
  connectedIds = new Set<string>(),
  pendingId = null,
  canManageProjectAuthorizations = true,
}: {
  connectedIds?: ReadonlySet<string>;
  pendingId?: string | null;
  canManageProjectAuthorizations?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <Modal open>
      <ConnectorAuthorizationGateContent
        profiles={[privateProfile, projectProfile]}
        connectedIds={connectedIds}
        pendingId={pendingId}
        canManageProjectAuthorizations={canManageProjectAuthorizations}
        onConnect={() => {}}
        onCancel={() => {}}
      />
    </Modal>,
  );
}

describe('ConnectorAuthorizationGateContent', () => {
  test('renders every required profile with its authorization strategy and accessible connect action', () => {
    const html = renderGate();

    expect(html).toContain('This session needs 2 connector profiles.');
    expect(html).toContain('Private calendar');
    expect(html).toContain('Project CRM');
    expect(html).toContain('Private');
    expect(html).toContain('Project');
    expect(html).toContain('Only your private sessions can use this authorization.');
    expect(html).toContain('Eligible project members can use this authorization.');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).toContain('aria-label="Connect Project CRM"');
  });

  test('requires a project manager for project authorization without management access', () => {
    const html = renderGate({ canManageProjectAuthorizations: false });

    expect(html).toContain('A project manager must connect this authorization.');
    expect(html).toContain('Manager required');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).not.toContain('aria-label="Connect Project CRM"');
  });

  test('renders connected and pending profiles without enabling another connect action', () => {
    const html = renderGate({
      connectedIds: new Set([projectProfile.id]),
      pendingId: privateProfile.id,
    });

    expect(html).toContain('Connected');
    expect(html).toContain('aria-label="Connect Private calendar"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('animate-spinner-orbit');
    expect(html).not.toContain('aria-label="Connect Project CRM"');
  });
});
