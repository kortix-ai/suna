// The Entitlements tab is the only UI for the operator-only Enterprise writes:
// the demo switch, license contracts (offer, end, withdraw, payment link) and
// per-key overrides. Losing a control in a refactor is silent — nothing else
// calls these routes — so this pins the wiring: the SDK hooks are the
// transport, destructive actions are confirmed, and the retired controls
// (the retired admin demo route, entitled switch, managed-models tri-state,
// compute multiplier, trials) stay gone. Same source-assertion style as `src/components/iam/enterprise-upsell.test.ts`.
import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const dir = import.meta.dir;
const pageSource = readFileSync(join(dir, 'page.tsx'), 'utf8');
const contractSource = readFileSync(join(dir, 'enterprise-contract-card.tsx'), 'utf8');

describe('admin accounts — Entitlements tab', () => {
  test('the tab is registered with a matching content panel', () => {
    expect(pageSource).toContain('<TabsTrigger value="entitlements"');
    expect(pageSource).toMatch(/<TabsContent value="entitlements"[\s\S]*?<EntitlementsTab/);
  });

  test('every write goes through an SDK hook, never a raw fetch', () => {
    expect(pageSource).toContain('useAdminSetOverrides');
    for (const hook of [
      'useSetEnterpriseDemo',
      'useAdminEnterpriseContracts',
      'useAdminCreateEnterpriseContract',
      'useAdminEndEnterpriseContract',
      'useAdminWithdrawEnterpriseOffer',
      'useAdminEnterpriseOfferLink',
    ]) {
      expect(contractSource).toContain(hook);
    }
    expect(pageSource).not.toContain('/admin/api/accounts/');
    expect(contractSource).not.toContain('/admin/api/accounts/');
    expect(contractSource).not.toContain('fetch(');
  });

  test('the retired controls are gone from the console', () => {
    for (const source of [pageSource, contractSource]) {
      for (const retired of [
        // Written as character classes so this file does not carry the names.
        'useAdminSet[E]nterpriseDemo',
        'useAdminSet[E]nterpriseEntitled',
        'useAdminSet[M]anagedModels',
        'compute[R]ateMultiplier',
        'demo[E]nterprise',
        'enterprise[E]ntitled',
        'managed[M]odelsOverride',
        'monthlyUsd != null &&',
        'trial.monthlyUsd',
      ]) {
        expect(source).not.toMatch(new RegExp(retired));
      }
    }
  });

  // Trials are removed (2026-10-15): the routes answer 410.
  test('no trial UI is left: no hooks, no grant form, no badge', () => {
    for (const gone of [
      'useAdmin[G]rantTrial',
      'useAdmin[R]evokeTrial',
      'TRIAL_[T]IER_OPTIONS',
      'handle[G]rantTrial',
      'account\\.[t]rial',
    ]) {
      expect(pageSource).not.toMatch(new RegExp(gone));
      expect(contractSource).not.toMatch(new RegExp(gone));
    }
  });

  // The page used to own a TIER_CATALOG and stamp "· legacy" onto any key in
  // it — a second, hand-maintained plan vocabulary that drifted from the
  // server's. The API now resolves the plan and ships it as `account.plan`; the page renders that.
  test('an account plan is rendered from the API plan block, never re-derived', () => {
    expect(pageSource).not.toContain('TIER_CATALOG');
    expect(pageSource).not.toMatch(/function tierLabel\b/);
    expect(pageSource).toMatch(
      /account\.plan\?\.label \?\? tierKeyLabel\(account\.tier(?:, options)?\)/,
    );
    expect(pageSource).toContain('account.plan?.sublabel');
    // Every place a plan is shown goes through the one component.
    for (const site of [
      '<PlanBadge account={account} />',
      '<PlanBadge key="tier" account={account} />',
    ]) {
      expect(pageSource).toContain(site);
    }
  });

  test('the word "legacy" is gone from the page entirely', () => {
    expect(pageSource).not.toContain('· legacy');
    expect(pageSource.toLowerCase()).not.toContain('legacy');
  });

  test('the tier filter sends the three raw plan keys', () => {
    // The list route filters on the STORED credit_accounts.tier column, so the
    // filter values must stay the raw keys even though nothing else on the
    // page names a plan from them.
    const options = pageSource.match(/TIER_OPTIONS[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(options).not.toBe('');
    for (const key of ['none', 'free', 'credits']) {
      expect(options).toContain(`value: '${key}'`);
    }
    // Enterprise is a feature layer, not a plan: no account stores it as a tier.
    for (const key of ['enterprise', 'per_seat', 'team', 'tier_']) {
      expect(options).not.toContain(`value: '${key}`);
    }
    expect(pageSource).not.toContain('Grandfathered');
  });

  test('the open sheet resolves a live row via the exact-id lookup, with list/snapshot fallback', () => {
    // The live source is useAdminAccount (immune to list filters); the filtered
    // list row and the click-time snapshot are only fallbacks while it loads.
    expect(pageSource).toContain('useAdminAccount(selected?.accountId ?? null)');
    expect(pageSource).toContain('selectedDetail.data ??');
    expect(pageSource).toContain('accounts.find((a) => a.accountId === selected.accountId) ??');
    expect(pageSource).toContain('<AccountDetailSheet account={selectedAccount}');
  });
});

describe('admin accounts — Overrides card', () => {
  test('the card is mounted in the Entitlements tab', () => {
    expect(pageSource).toMatch(
      /function EntitlementsTab[\s\S]*?<OverridesCard account=\{account\}/,
    );
  });

  test('every override row the server accepts has a control, and only those', () => {
    const rows =
      pageSource.match(/OVERRIDE_ENTITLEMENT_ROWS[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(rows).not.toBe('');
    for (const key of ['sso', 'scim', 'rbac', 'auditAccess', 'branding', 'managedModels', 'byokFee']) {
      expect(rows).toContain(`key: '${key}'`);
    }
    expect(rows.match(/key: '/g)).toHaveLength(7);
  });

  test('the entitlement rows are tri-state — inherit, force on, force off', () => {
    const options =
      pageSource.match(/OVERRIDE_TRI_STATE_OPTIONS[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    for (const value of ['inherit', 'on', 'off']) {
      expect(options).toContain(`value: '${value}'`);
    }
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

describe('admin accounts — Enterprise contract card', () => {
  test('the card is mounted in the Entitlements tab', () => {
    expect(pageSource).toMatch(
      /function EntitlementsTab[\s\S]*?<EnterpriseContractCard account=\{account\}/,
    );
  });

  test('the form offers the three collection modes and the term cap', () => {
    for (const value of ['checkout', 'invoice', 'manual']) {
      expect(contractSource).toContain(`case '${value}'`);
    }
    expect(contractSource).toContain('MAX_TERM_MONTHS_STRIPE = 12');
    expect(contractSource).toContain('MAX_TERM_MONTHS_MANUAL = 60');
  });

  test('ending a contract is confirmed, and the payment link is copied from checkout_url', () => {
    expect(contractSource).toContain('onClick={() => setConfirmEnd(true)}');
    expect(contractSource).toMatch(/<ConfirmDialog[\s\S]*?onConfirm=\{handleEnd\}/);
    expect(contractSource).toContain('navigator.clipboard.writeText(checkout_url)');
  });

  test('the card shows the Enterprise state, and the demo switch unless licensed', () => {
    for (const label of ['Enterprise · demo', 'Enterprise · licensed', 'Licensed', 'Turn on demo', 'Turn off demo']) {
      expect(contractSource).toContain(label);
    }
    expect(contractSource).toContain("enterprise !== 'licensed' && (");
    expect(contractSource).toContain('setDemo.mutate(');
    // The list row is stale until the admin list refetches.
    expect(contractSource).toContain("queryKey: ['admin', 'accounts']");
    expect(contractSource).toContain("t('text06bdc1c507f1', { date: day(account.graceEndsAt) })");
  });

  test('a license carries no credits: no credits field, invoice by default', () => {
    expect(contractSource).not.toContain('setCredits');
    expect(contractSource).not.toContain('Credits USD / year');
    expect(contractSource).not.toContain('c.creditsUsd');
    expect(contractSource).not.toContain('contract.creditsUsd');
    expect(contractSource).toContain("useState<AdminContractCollection>('invoice')");
    expect(contractSource).not.toContain('creditsUsd');
  });

  test('the list and sheet show the plan state line', () => {
    expect(pageSource).toContain('<AccountPlanState account={account} />');
  });
});
