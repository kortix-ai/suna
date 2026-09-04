import { describe, expect, test } from 'bun:test';

import embeddedStarter from '../embedded.generated.json' with { type: 'json' };
import { buildEmbeddedSnapshot } from '../../scripts/generate-embedded';

/**
 * Guards against a stale committed snapshot. The compiled `kortix` binary
 * serves starter files from `embedded.generated.json`, so if a template file
 * changes without regenerating the snapshot, the binary would ship the old
 * content. Regenerate with `bun run scripts/generate-embedded.ts`.
 */
describe('embedded starter snapshot', () => {
  test('is in sync with the on-disk template tree', () => {
    const fresh = buildEmbeddedSnapshot();
    expect(embeddedStarter).toEqual(fresh as typeof embeddedStarter);
  });

  test('includes the general knowledge worker skill pack', () => {
    const gkw = (embeddedStarter as Record<string, { files: { path: string }[] }>)[
      'general-knowledge-worker'
    ];
    const skillFiles = gkw.files.filter((f) =>
      f.path.startsWith('.kortix/opencode/skills/'),
    );
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  test('does not ship gated agent tunnel skill by default', () => {
    for (const starter of Object.values(
      embeddedStarter as Record<string, { files: { path: string }[] }>,
    )) {
      expect(starter.files.some((f) => f.path.includes('/agent-tunnel/'))).toBe(false);
    }
  });

  test('teaches managed agents to use Composio instead of selecting Pipedream', () => {
    const managed = (embeddedStarter as Record<string, { files: { path: string; content: string }[] }>)[
      'managed'
    ];
    const connectorSkill = managed.files.find((file) =>
      file.path.endsWith('/kortix-connectors/SKILL.md'),
    );
    expect(connectorSkill?.content).toContain('--provider composio');
    expect(connectorSkill?.content).toContain('Pipedream exists only for rollback compatibility');
    for (const file of managed.files) {
      expect(file.content).not.toContain('--provider pipedream --app');
      expect(file.content).not.toContain('Pipedream Quick Connect');
    }
  });

  test('marketplace templates use Composio wherever a live toolkit exists', () => {
    const marketplace = (embeddedStarter as Record<string, { files: { path: string; content: string }[] }>)[
      'marketplace'
    ];
    const registryFile = marketplace.files.find((file) => file.path === 'kortix.registry.json');
    expect(registryFile).toBeDefined();
    const registry = JSON.parse(registryFile!.content) as {
      items: Array<{
        meta?: { template?: { connectors?: Array<{ provider?: string; app?: string }> } };
      }>;
    };
    const connectors = registry.items.flatMap((item) => item.meta?.template?.connectors ?? []);
    expect(connectors.filter((connector) => connector.provider === 'composio')).toHaveLength(82);
    const legacyApps = new Set(
      connectors
        .filter((connector) => connector.provider === 'pipedream')
        .map((connector) => connector.app),
    );
    expect(legacyApps).toEqual(
      new Set(['aws', 'clearbit', 'google_workspace', 'okta', 'plaid', 'postgresql']),
    );
  });
});
