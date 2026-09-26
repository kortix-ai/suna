import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connector-settings.tsx'), 'utf8');

/**
 * Source-assertion tripwires, in the shape of
 * `connector-tools.write-path.test.ts`. One thing on this tab cannot be
 * proven by a rendered-output test without a full react-query + mutation
 * harness, and it is load-bearing: removing a connector must never fire from
 * the click that opens the dialog — only from `ConfirmDialog`'s own confirm
 * action.
 *
 * The "Connects as" / authorization-owner tests that used to live here
 * (`lockedReason` wording, `AuthorizationStrategyField` with `hideLabel`) are
 * REMOVED, not rewritten — that whole control is gone from this tab
 * (connector-credentials rework). `connector-settings.tsx`'s own docstring:
 * "The 'Connects as' row is gone... Ownership is now a property of each
 * account — see the Accounts tab." `ConnectorSettingsProps` is exactly
 * `{projectId, connector, displayName, onChanged, onRemoved}` now — no
 * `strategyUpdating`, no `onAuthorizationStrategyChange`.
 *
 * `ConnectionSection` (transport config: slug/provider/spec/auth/headers)
 * moved HERE, direct-provider-only, in the connector-accounts-tab-bug
 * follow-up: `connector-accounts.tsx` used to gate `ConnectionsList` on
 * `isManagedConnectorProvider` and fall every direct provider (openapi/http/
 * mcp/graphql/…) through to `ConnectionSection` instead of its account list.
 * Accounts now always renders `ConnectionsList`; this tab is the only place
 * left that mounts the transport form.
 */
describe('connector settings write path', () => {
  test('carries no authorization-strategy control any more', () => {
    expect(source).not.toContain('AuthorizationStrategyField');
    expect(source).not.toContain('strategyUpdating');
    expect(source).not.toContain('onAuthorizationStrategyChange');
    expect(source).not.toContain('lockedReason');
  });

  test('the danger row never mutates directly — only ConfirmDialog does', () => {
    // The visible Remove button only opens the dialog.
    const removeButtonBlock = source.slice(source.indexOf('<Button'), source.indexOf('</Button>'));
    expect(removeButtonBlock).toContain('onClick={() => setConfirmDelete(true)}');
    expect(removeButtonBlock).not.toContain('remove.mutate()');

    // The mutation itself only fires from ConfirmDialog's onConfirm.
    const calls = [...source.matchAll(/remove\.mutate\(\)/g)];
    expect(calls).toHaveLength(1);
    const confirmDialogBlock = source.slice(source.indexOf('<ConfirmDialog'));
    expect(confirmDialogBlock).toContain('onConfirm={() => remove.mutate()}');
    expect(confirmDialogBlock).toContain('confirmVariant="destructive"');
  });

  test('the danger row itself carries no destructive variant — only the dialog button does', () => {
    // The panel stays neutral; only ConfirmDialog's own confirm button is
    // destructive. Scoped to the Remove `<Button>` element itself, not the
    // surrounding prose, which legitimately names "destructive" in a comment
    // explaining this exact rule.
    const removeButtonBlock = source.slice(source.indexOf('<Button'), source.indexOf('</Button>'));
    expect(removeButtonBlock).not.toContain('variant="destructive"');
  });

  test('the danger row matches the design-system danger-zone shape', () => {
    expect(source).toContain('bg-popover rounded-md border px-4 py-3');
    expect(source).toContain('variant="outline"');
    expect(source).toContain('size="sm"');
  });

  test('ConnectionSection is imported and mounted, gated to direct providers only', () => {
    // Managed (Composio/Pipedream), channel, and computer connectors have no
    // transport config of their own — Accounts (`ConnectionsList`,
    // `ChannelConnectionSection`, `ComputerConnectorAccount`) covers them.
    expect(source).toMatch(/import\s*\{[^}]*\bConnectionSection\b/);
    expect(source).toContain('const isDirectProvider =');
    expect(source).toContain(
      '!isManagedConnectorProvider(connector.provider) && !isChannel && !isComputer',
    );
    expect(source).toMatch(/\{isDirectProvider \? \(\s*<ConnectionSection/);
  });

  test('the credential/config form is not duplicated — ChannelConnectionSection is never imported here', () => {
    // Channel connectors keep their own connect flow on the Accounts tab
    // (`ChannelConnectionSection`, mounted from `connector-accounts.tsx`).
    // Importing it here too would render the same form on two tabs at once.
    expect(source).not.toMatch(/import\s*\{[^}]*\bChannelConnectionSection\b/);
  });

  test('this tab is the only place connector removal is wired in the capabilities tree', () => {
    // `../..` is the capabilities root: this file sits at connectors/detail/.
    const root = join(import.meta.dir, '..', '..');
    const callers = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter(
        (name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'),
      )
      .filter((name) => readFileSync(join(root, name), 'utf8').includes('deleteConnector('));
    expect(callers).toEqual(['connectors/detail/connector-settings.tsx']);
  });
});
