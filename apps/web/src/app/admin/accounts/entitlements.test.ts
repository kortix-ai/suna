// The Entitlements tab is the only UI for four operator-only writes (trial
// grant/revoke, managed-models override, enterprise demo, enterprise contract
// entitlement). Losing a control in a refactor is silent — nothing else calls
// these routes — so this pins the wiring: the SDK hooks are the transport, the
// destructive action is confirmed, and the tri-state override can express all
// three states. Same source-assertion style as
// `src/components/iam/enterprise-upsell.test.ts`.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const pageSource = readFileSync(join(dir, 'page.tsx'), 'utf8');
const demoCardSource = readFileSync(
  join(dir, '../../../components/iam/enterprise-demo-card.tsx'),
  'utf8',
);

describe('admin accounts — Entitlements tab', () => {
  test('the tab is registered with a matching content panel', () => {
    expect(pageSource).toContain('<TabsTrigger value="entitlements"');
    expect(pageSource).toMatch(/<TabsContent value="entitlements"[\s\S]*?<EntitlementsTab/);
  });

  test('every write goes through an SDK hook, never a raw fetch', () => {
    for (const hook of [
      'useAdminGrantTrial',
      'useAdminRevokeTrial',
      'useAdminSetManagedModels',
      'useAdminSetEnterpriseDemo',
      'useAdminSetEnterpriseEntitled',
    ]) {
      expect(pageSource).toContain(hook);
    }
    expect(pageSource).not.toContain('/admin/api/accounts/');
  });

  test('trial grant sends tier, seats, duration, credit grant and note', () => {
    const grant = pageSource.match(/grantTrial\.mutateAsync\(\{([\s\S]*?)\}\);/)?.[1] ?? '';
    expect(grant).not.toBe('');
    for (const field of ['tierKey', 'seats:', 'durationDays', 'creditGrant', 'note:']) {
      expect(grant).toContain(field);
    }
  });

  test('the grant form defaults to 5 seats, 30 days and a $25 credit grant', () => {
    expect(pageSource).toContain("useState('5')");
    expect(pageSource).toContain("useState('30')");
    expect(pageSource).toContain("useState('25')");
    for (const preset of [14, 30, 60, 90]) {
      expect(pageSource).toContain(String(preset));
    }
  });

  test('revoking a trial is confirmed, never fired from a single click', () => {
    expect(pageSource).toMatch(/onClick=\{\(\) => setConfirmRevoke\(true\)\}/);
    expect(pageSource).toMatch(/<ConfirmDialog[\s\S]*?onConfirm=\{handleRevokeTrial\}/);
  });

  test('managed models is tri-state — null, true and false are all reachable', () => {
    const choices =
      pageSource.match(/managedModelsChoices[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(choices).toContain('value: null');
    expect(choices).toContain('value: true');
    expect(choices).toContain('value: false');
  });

  test('trial picker offers exactly Team and Enterprise — model access is the switch, not the tier', () => {
    const options = pageSource.match(/TRIAL_TIER_OPTIONS[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(options).not.toBe('');
    for (const tier of ['team', 'enterprise']) {
      expect(options).toContain(`value: '${tier}'`);
    }
    // Never offer non-plans, legacy plans, or the whole catalog — that picker
    // confused even the founder ("what are these tiers dude").
    for (const tier of ['free', 'none', 'starter', 'pro', 'per_seat', 'scale', 'tier_']) {
      expect(options).not.toContain(`value: '${tier}'`);
    }
  });

  // The page used to own a TIER_CATALOG and stamp "· legacy" onto any key in
  // it — a second, hand-maintained plan vocabulary that drifted from the
  // server's. The API now resolves the plan (trial + per-seat self-heal
  // applied) and ships it as `account.plan`; the page renders that.
  test('an account plan is rendered from the API plan block, never re-derived', () => {
    expect(pageSource).not.toContain('TIER_CATALOG');
    expect(pageSource).not.toMatch(/function tierLabel\b/);
    expect(pageSource).toMatch(/account\.plan\?\.label \?\? tierKeyLabel\(account\.tier\)/);
    expect(pageSource).toContain('account.plan?.sublabel');
    // Every place a plan is shown goes through the one component.
    for (const site of [
      '<PlanBadge account={account} />',
      '<PlanBadge account={account} size="default" />',
      '<PlanBadge key="tier" account={account} />',
    ]) {
      expect(pageSource).toContain(site);
    }
  });

  test('the word "legacy" is gone from the page entirely', () => {
    expect(pageSource).not.toContain('· legacy');
    expect(pageSource.toLowerCase()).not.toContain('legacy');
  });

  test('the tier filter still sends raw tier keys, grandfathered ones grouped', () => {
    // The list route filters on the STORED credit_accounts.tier column, so the
    // filter values must stay the raw keys even though nothing else on the
    // page names a plan from them.
    const options = pageSource.match(/TIER_OPTIONS[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(options).not.toBe('');
    for (const key of ['free', 'none', 'per_seat', 'tier_25_200', 'enterprise']) {
      expect(options).toContain(`value: '${key}'`);
    }
    expect(options).toContain('grandfathered: true');
    expect(pageSource).toContain('Grandfathered');
  });

  test('the open sheet resolves a live row via the exact-id lookup, with list/snapshot fallback', () => {
    // The live source is useAdminAccount (immune to list filters); the filtered
    // list row and the click-time snapshot are only fallbacks while it loads.
    expect(pageSource).toContain('useAdminAccount(selected?.accountId ?? null)');
    expect(pageSource).toContain('selectedDetail.data ??');
    expect(pageSource).toContain(
      'accounts.find((a) => a.accountId === selected.accountId) ??',
    );
    expect(pageSource).toContain('<AccountDetailSheet account={selectedAccount}');
  });
});

describe('admin accounts — Overrides card', () => {
  test('the card is mounted in the Entitlements tab', () => {
    expect(pageSource).toMatch(/function EntitlementsTab[\s\S]*?<OverridesCard account=\{account\}/);
  });

  test('every override row the server accepts has a control', () => {
    const rows = pageSource.match(/OVERRIDE_ENTITLEMENT_ROWS[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(rows).not.toBe('');
    for (const key of ['sso', 'scim', 'rbac', 'auditAccess', 'branding', 'managedModels']) {
      expect(rows).toContain(`key: '${key}'`);
    }
    // The two numeric overrides are laid out by hand — an input, not a Select.
    expect(pageSource).toContain("aria-label=\"Max concurrent sessions override\"");
    expect(pageSource).toContain("aria-label=\"Compute rate multiplier override\"");
  });

  test('the entitlement rows are tri-state — inherit, force on, force off', () => {
    const options =
      pageSource.match(/OVERRIDE_TRI_STATE_OPTIONS[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    for (const value of ['inherit', 'on', 'off']) {
      expect(options).toContain(`value: '${value}'`);
    }
  });

  test('the compute multiplier input carries the range and step the server enforces', () => {
    const at = pageSource.indexOf('aria-label="Compute rate multiplier override"');
    expect(at).toBeGreaterThan(-1);
    const declaration = pageSource.slice(at - 400, at + 400);
    expect(declaration).toContain('min={0}');
    expect(declaration).toContain('max={MAX_COMPUTE_RATE_MULTIPLIER}');
    expect(declaration).toContain('step={0.05}');
    expect(declaration).toContain('draft.computeRateMultiplier');
  });

  test('the whole card saves through one merge-patch mutation', () => {
    expect(pageSource).toContain('useAdminSetOverrides');
    expect(pageSource).toMatch(
      /setOverrides\.mutateAsync\(\{ accountId: account\.accountId, patch: result\.patch \}\)/,
    );
    // The diff is computed by the pure helper, never rebuilt inline — that is
    // what keeps an untouched row (and its expiry) out of the patch.
    expect(pageSource).toContain('overridesPatch(draft, stored)');
  });

  test('a stored expiry is visible on its row', () => {
    expect(pageSource).toContain('<OverrideExpiryChip');
    expect(pageSource).toContain('overrideExpiresAt(stored,');
    expect(pageSource).toContain('isOverrideExpired(expiresAt)');
  });

  test('Save is inert until something actually changed', () => {
    expect(pageSource).toContain('disabled={!dirty || !result.ok || setOverrides.isPending}');
  });

  test('a validation failure is shown inline, not sent to the server', () => {
    expect(pageSource).toContain('{!result.ok && <p className="text-kortix-red text-xs">');
  });
});

describe('admin accounts — Ledger tab', () => {
  test('the ledger renders the customer-facing table, not a second list', () => {
    expect(pageSource).toContain('<CreditTransactionsTable rows={adminLedgerRows(entries)} />');
    // The hand-rolled row markup is gone: no per-entry amount coloring left in
    // the page, which is what drifted from the customer surface.
    expect(pageSource).not.toContain('text-emerald-600 dark:text-emerald-400');
  });
});

describe('EnterpriseDemoCard — the self-serve toggle is now admin-only', () => {
  test('the switch is gated on the platform-admin role', () => {
    expect(demoCardSource).toContain('useAdminRole');
    expect(demoCardSource).toMatch(/isPlatformAdmin \? \(\s*<Switch/);
  });

  // The card became a `SettingsRow` on 2026-08-12 (it used to draw its own
  // bordered box; the settings panel mounts it inside a `SettingsRowGroup`
  // now). The hint moved from a standalone `<p>` under the title into the row's
  // `description`, so this reads the ternary that picks it rather than a JSX
  // block. What is asserted is unchanged: a non-admin is told who can turn this
  // on, and is given a state badge instead of a switch that would only 403.
  test('non-admins get read-only state plus a contact hint, not a switch that 403s', () => {
    expect(demoCardSource).toMatch(/!isPlatformAdmin\s*\?\s*'[^']*Contact Kortix/);
    expect(demoCardSource).toMatch(/<Badge variant=\{enabled \? 'success' : 'muted'\}/);
  });
});
