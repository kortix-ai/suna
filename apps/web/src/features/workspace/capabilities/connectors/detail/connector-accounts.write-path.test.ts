import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connector-accounts.tsx'), 'utf8');

/**
 * A source-assertion tripwire, in the shape of
 * `connector-settings.write-path.test.ts` / `connector-tools.write-path.test.ts`.
 *
 * The defect this guards: opening a connector whose provider is `openapi`
 * (also `http`, `mcp`, `graphql`) rendered `ConnectionSection` — the
 * transport/credential config form (Slug / Provider / Spec / Auth / Headers)
 * — on the Accounts tab instead of the account list, because the old branch
 * only gave `ConnectionsList` to `isManagedConnectorProvider` connectors
 * (Composio/Pipedream) and let every direct provider fall through to
 * `ConnectionSection`. Found live: connector `crm` (openapi, bearer) with two
 * member accounts opened the raw form, not "Work" / "Personal".
 *
 * Fixture that proves it now: `crm` (openapi) with member accounts "Work"
 * (default) and "Personal" must show `ConnectionsList`'s two groups, not a
 * Slug/Provider/Spec/Auth/Headers form.
 */
describe('connector accounts tab branch', () => {
  test('a computer profile renders ComputerConnectorAccount, before any other branch', () => {
    const computerBlock = source.slice(
      source.indexOf('if (isComputer)'),
      source.indexOf('if (isChannel)'),
    );
    expect(computerBlock).toContain('<ComputerConnectorAccount');
    expect(computerBlock).not.toContain('<ConnectionsList');
    expect(computerBlock).not.toContain('<ChannelConnectionSection');
  });

  test('a channel connector renders ChannelConnectionSection, not the accounts list', () => {
    const channelBlock = source.slice(
      source.indexOf('if (isChannel)'),
      source.indexOf('return (\n    <div className="space-y-5">'),
    );
    expect(channelBlock).toContain('<ChannelConnectionSection');
    expect(channelBlock).not.toContain('<ConnectionsList');
  });

  // The fix: every OTHER provider — managed (Composio/Pipedream) AND direct
  // (openapi/http/mcp/graphql/…) alike — falls through to the SAME
  // `ConnectionsList` mount. There is no longer an `isManagedProvider` gate
  // between "renders the account list" and "renders the transport form": a
  // direct provider has no separate branch at all any more.
  test('every non-channel, non-computer provider renders ConnectionsList — no isManagedProvider gate on it', () => {
    const tail = source.slice(source.indexOf('if (isChannel)'));
    expect(tail).toContain('<ConnectionsList');
    // The old defect: `if (isManagedProvider) { return <ConnectionsList ... />; }`
    // guarding the list, with every direct provider falling through to
    // `ConnectionSection` below it.
    expect(source).not.toMatch(/if\s*\(\s*isManagedProvider\s*\)/);
    expect(source).not.toContain('<ConnectionSection');
  });

  test('ConnectionSection is never imported here — it moved to the Settings tab', () => {
    // Both are exported from connectors-view.tsx. Importing ConnectionSection
    // here too would print the transport/credential form on Accounts AND
    // Settings at once.
    expect(source).not.toMatch(/import\s*\{[^}]*\bConnectionSection\b/);
  });

  test('there is no reader-only banner gate left standing in place of the list', () => {
    // The removed `!canWrite` early-return used to swap `ConnectionSection`
    // for a "runs on one shared account / each person's own account" banner.
    // `ConnectionsList` reads fine for anyone (same as the managed-provider
    // path always allowed), so that gate is gone, not relocated.
    expect(source).not.toMatch(/if\s*\(\s*!canWrite\s*\)/);
  });

  test('the roster stays gated to managed, per-user connectors only', () => {
    expect(source).toContain(
      "isManagedProvider && canManageConnections && connector.authorizationStrategy === 'user'",
    );
  });

  test('branch order: computer, then channel, then the accounts list', () => {
    const computerIdx = source.indexOf('if (isComputer)');
    const channelIdx = source.indexOf('if (isChannel)');
    const listIdx = source.indexOf('<ConnectionsList');
    expect(computerIdx).toBeGreaterThan(-1);
    expect(channelIdx).toBeGreaterThan(computerIdx);
    expect(listIdx).toBeGreaterThan(channelIdx);
  });
});
