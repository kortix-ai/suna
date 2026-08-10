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

  test('legacy tiers are labelled as legacy wherever tier keys render', () => {
    const catalog = pageSource.match(/TIER_CATALOG[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(catalog).toContain('legacy: true');
    expect(pageSource).toMatch(/entry\.legacy \? `\$\{entry\.label\} · legacy` : entry\.label/);
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

describe('EnterpriseDemoCard — the self-serve toggle is now admin-only', () => {
  test('the switch is gated on the platform-admin role', () => {
    expect(demoCardSource).toContain('useAdminRole');
    expect(demoCardSource).toMatch(/isPlatformAdmin \? \(\s*<Switch/);
  });

  test('non-admins get read-only state plus a contact hint, not a switch that 403s', () => {
    expect(demoCardSource).toMatch(/!isPlatformAdmin \? \([\s\S]*?Contact Kortix to enable/);
    expect(demoCardSource).toMatch(/<Badge variant=\{enabled \? 'success' : 'muted'\}/);
  });
});
