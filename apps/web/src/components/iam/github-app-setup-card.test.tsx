import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'github-app-setup-card.tsx'), 'utf8');
const flatSource = source.replace(/\s+/g, ' ');

describe('managed GitHub setup card', () => {
  test('uses the published managed Nango SDK lifecycle', () => {
    expect(source).toContain('getManagedGitHubStatus');
    expect(source).toContain('createManagedGitHubConnectSession');
    expect(source).toContain('listManagedGitHubCandidates');
    expect(source).toContain('selectManagedGitHubCandidate');
    expect(source).toContain('createManagedGitHubReconnectSession');
    expect(source).toContain('disconnectManagedGitHubConnection');
    expect(source).toContain("from '@nangohq/frontend'");
  });

  test('renders every candidate and requires a separate Select action', () => {
    expect(source).toContain('candidates.map');
    expect(source).toContain('Select');
    expect(source).toContain('selectMutation.mutate(candidate.connection_id)');
    expect(flatSource).not.toMatch(/event\.type === 'connect'.{0,300}selectManagedGitHubCandidate/);
  });

  test('offers reconnect and disconnect controls', () => {
    expect(source).toContain('Reconnect');
    expect(source).toContain('Disconnect');
    expect(source).toContain('confirmDisconnectOpen');
    expect(flatSource).toContain(
      "candidate.selected || candidate.status !== 'connected'",
    );
  });

  test('identifies managed connections with missing write permissions', () => {
    expect(source).toContain('missingManagedGitHubPermissions');
    expect(source).toContain('Contents: read and write');
    expect(source).toContain('Pull requests: read and write');
  });

  test('does not expose legacy App, private-key, or PAT setup inputs', () => {
    expect(source).not.toContain('startGitHubAppManifest');
    expect(source).not.toContain('setGitHubAppFromExisting');
    expect(source).not.toContain('setGitHubAppPat');
    expect(source).not.toContain('Private key');
    expect(source).not.toContain('Personal access token');
    expect(source).not.toContain('Paste an existing App');
    expect(source).not.toContain('<Textarea');
    expect(source).not.toContain('<Input');
  });
});
