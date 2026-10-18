// The IAM surfaces (Audit, SSO/SCIM) are enterprise-gated: non-entitled
// accounts must see the upsell card instead of the feature. An owner or admin
// turns on the Enterprise demo in one click; anyone talks to sales in one
// click, with no form. Guards the page wiring so a refactor can't silently
// un-gate a tab.
//
// Roles is deliberately NOT one of them (its `roles` copy variant was
// deleted 2026-08-18 — written, never rendered), and neither is Groups: both
// carry free content server-side, so they always mount and gate only their
// own write controls on `rbacEnabled`.
import { NAV_GROUPS } from '@/features/accounts/hub/sections';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

const dir = import.meta.dir;
const upsellSource = readFileSync(join(dir, 'enterprise-upsell.tsx'), 'utf8');
const pageSource = readFileSync(join(dir, '../../features/accounts/hub/account-hub-content.tsx'), 'utf8');

describe('EnterpriseUpsell component', () => {
  test('a billing manager turns on the demo; everyone else is told who can, and anyone talks to sales', () => {
    expect(upsellSource).toContain('useEnterpriseDemo(accountId)');
    expect(upsellSource).toContain('demo.set(true)');
    expect(upsellSource).toContain("t('demoTurnOnEnterprise')");
    expect(upsellSource).toContain("manager ? t('upsellDemoHint') : t('upsellAskManager')");
    expect(upsellSource).toContain('canManageBilling(');
    // One click, no demo-booking form.
    expect(upsellSource).toContain('useTalkToSales(accountId)');
    expect(upsellSource).not.toContain('useRequestDemo');
  });

  test('covers the gated surfaces, Roles included', () => {
    for (const feature of ['groups:', 'audit:', 'identity:', 'branding:', 'roles:']) {
      expect(upsellSource).toContain(feature);
    }
  });

  // Jay, 2026-10-13: the Enterprise tag carried a lock glyph inside a grey
  // badge. One plan tag now: words only, the info tint, sans text.
  test('the Enterprise tag has no lock and uses the shared EnterpriseBadge', () => {
    expect(upsellSource).not.toContain('LockIcon');
    expect(upsellSource).toContain('export function EnterpriseBadge');
    expect(upsellSource).toContain('<EnterpriseBadge />');
  });
});

describe('account page gates each IAM surface behind the entitlement', () => {
  // The hub does not swap Groups or Roles for an upsell: `GET .../groups` and
  // `GET .../roles` carry no entitlement check server-side. Each tab decides
  // on its own from `rbacEnabled`: without Enterprise, Roles renders only
  // `EnterpriseUpsell`, and Groups renders it while the account has no groups.
  // "No entitlement gate" — NOT "no gate". PERMISSION is a separate axis and
  // both panes now carry it (`sectionVisible.groups` / `.roles`, from the
  // `group.read` / `role.read` probes): a caller who cannot read the list must
  // not get a rail item that opens onto "you don't have permission". What this
  // pins is that neither pane is swapped for an EnterpriseUpsell card — see
  // `accounts/[id]/account-hub-section-gating.test.ts` for the permission map.
  test('groups tab: no entitlement gate, passed rbacEnabled to gate its own controls', () => {
    expect(pageSource).toMatch(
      /activeSection === 'groups' && sectionVisible\.groups \?[\s\S]*?<GroupsTab/,
    );
    expect(pageSource).toMatch(/<GroupsTab[\s\S]*?rbacEnabled=\{rbacEnabled\}/);
    expect(pageSource).not.toContain('<EnterpriseUpsell feature="groups" accountId={account.account_id} />');
  });

  test('roles tab: no entitlement gate, passed rbacEnabled to gate its own controls', () => {
    expect(pageSource).toMatch(
      /activeSection === 'roles' && sectionVisible\.roles \?[\s\S]*?<RolesTab/,
    );
    expect(pageSource).toMatch(/<RolesTab[\s\S]*?rbacEnabled=\{rbacEnabled\}/);
    expect(pageSource).not.toContain('<EnterpriseUpsell feature="roles" accountId={account.account_id} />');
  });

  test('audit tab: auditAccess entitlement or upsell', () => {
    expect(pageSource).toContain('const auditEnabled = !!entitlements?.auditAccess');
    expect(pageSource).toMatch(/auditEnabled \? \(\s*<AuditTab/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="audit" accountId={account.account_id} />');
  });

  test('identity section: sso/scim entitlement or upsell (cards no longer just hidden)', () => {
    // A short "why connect both" explainer sits above the two cards — allow
    // it between the entitlement check and <SsoCard> while still asserting
    // SsoCard renders before ScimCard.
    expect(pageSource).toMatch(/enterpriseIdentityEnabled \? \([\s\S]*?<SsoCard[\s\S]*?<ScimCard/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="identity" accountId={account.account_id} />');
  });

  test('branding pane: branding entitlement or upsell', () => {
    expect(pageSource).toContain('const brandingEnabled = !!entitlements?.branding');
    expect(pageSource).toMatch(/brandingEnabled \? \(\s*<BrandingTab/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="branding" accountId={account.account_id} />');
  });

  test('no upsell flash while entitlements load', () => {
    expect(pageSource).toContain('entitlementsLoading');
  });
});

describe('account page rail groups every access surface under Access', () => {
  // 2026-08-18 centralized-IAM redesign: ONE "Access" cluster holds every
  // facet of the same access-control concern. Identity and Audit moved into
  // it and the "Enterprise" group was deleted — a heading naming a plan
  // mislabels surfaces that all carry free content (the built-in roles, an
  // account's real group list, the identity intro), and split the one
  // question a visitor has ("who can do what here?") across two headings.
  // The rail used to be a literal inside `page.tsx` and this read its source.
  // It is `NAV_GROUPS` in the hub catalog now, so both tests assert on the
  // real exported data and can no longer silently stop matching.
  test('the rail has a labeled Access group with every access surface in it', () => {
    const accessGroup = NAV_GROUPS.find((group) => group.label === 'Access');
    expect(accessGroup).toBeDefined();
    const ids = (accessGroup?.items ?? []).map((item) => item.id);
    for (const id of ['members', 'groups', 'roles', 'identity', 'audit'] as const) {
      expect(ids).toContain(id);
    }
  });

  test('the Enterprise nav group is gone', () => {
    expect(NAV_GROUPS.map((group) => group.label)).not.toContain('Enterprise');
  });

  test('identity is its own section, not buried in Settings', () => {
    expect(pageSource).toMatch(/activeSection === 'identity' && canWriteAccount/);
    const settingsStart = pageSource.indexOf("activeSection === 'settings' && canWriteAccount");
    expect(settingsStart).toBeGreaterThan(-1);
    const settingsEnd = pageSource.indexOf('section-panes:end', settingsStart);
    const settingsBody = pageSource.slice(settingsStart, settingsEnd);
    // The connection cards (and the tokens-tab cards) still live only on
    // their own sections — SsoCard/ScimCard never move into Settings.
    for (const moved of ['SsoCard', 'ScimCard', 'PatPolicyCard']) {
      expect(settingsBody).not.toContain(moved);
    }
  });

  // The Enterprise row moved to Billing (2026-10-15): the demo, the license
  // and the plan are read and managed in one place.
  test('the Enterprise access row is not in Settings or Identity', () => {
    expect(pageSource).not.toContain('EnterpriseAccessRow');
  });

  /**
   * `PatPolicyCard` + `ServiceAccountsCard` until 2026-08-12, when both were
   * replaced by the components the settings panel's API keys tab mounts. The
   * order flipped with them: the keys come first now, the rules that govern
   * them second — the same fix made in `tabs/api-keys-tab.tsx`, for the same
   * reason (a policy form is not what someone opening "Tokens" came for).
   */
  test('tokens section carries the keys list and then the key rules', () => {
    expect(pageSource).toMatch(/activeSection === 'tokens' && sectionVisible.tokens/);
    expect(pageSource).toMatch(
      /activeSection === 'tokens'[\s\S]*?<ApiKeysSection[\s\S]*?<KeyRulesCard/,
    );
  });

  test('audit webhooks live on the audit tab, gated on entitlement + write', () => {
    expect(pageSource).toMatch(/auditEnabled && canWriteAccount \? \(\s*<AuditWebhooksCard/);
  });
});
