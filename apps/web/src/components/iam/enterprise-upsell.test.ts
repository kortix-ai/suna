// The IAM surfaces (Audit, SSO/SCIM) are enterprise-gated: non-entitled
// accounts must see the upsell card — with the "Request a demo" CTA —
// instead of the feature. The CTA opens the in-app demo-request modal
// (useRequestDemo) rather than navigating out to the marketing page. Guards
// the page wiring so a refactor can't silently un-gate a tab.
//
// Roles is deliberately NOT one of them (its `roles` copy variant was
// deleted 2026-08-18 — written, never rendered), and neither is Groups: both
// carry free content server-side, so they always mount and gate only their
// own write controls on `rbacEnabled`.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const upsellSource = readFileSync(join(dir, 'enterprise-upsell.tsx'), 'utf8');
const pageSource = readFileSync(join(dir, '../../app/(app)/accounts/[id]/page.tsx'), 'utf8');

describe('EnterpriseUpsell component', () => {
  test('CTA opens the in-app demo-request modal', () => {
    expect(upsellSource).toContain('useRequestDemo');
    expect(upsellSource).toContain('openDemo(');
    expect(upsellSource).toContain('Request a demo');
  });

  test('covers the gated surfaces, and no longer carries the dead roles variant', () => {
    for (const feature of ['groups:', 'audit:', 'identity:']) {
      expect(upsellSource).toContain(feature);
    }
    // Deleted 2026-08-18: `RolesTab` gates itself with an inline InfoBanner,
    // so this copy variant was unreachable in every code path.
    expect(upsellSource).not.toContain('Custom roles are an Enterprise feature');
    expect(upsellSource).not.toMatch(/^\s{2}roles: \{/m);
  });
});

describe('account page gates each IAM surface behind the entitlement', () => {
  // Groups and Roles are NOT gated the way Audit/Identity are: `GET
  // .../groups` and `GET .../roles` carry no entitlement check server-side
  // (only the mutating routes do), so the built-in roles and an account's
  // real group list are free content, not upsell. `GroupsTab`/`RolesTab`
  // always render and gate only their own "Create"/"New role" controls on
  // `rbacEnabled` internally — see this file's other describe block, and
  // `page.tsx`'s comment above these two sections.
  // "No entitlement gate" — NOT "no gate". PERMISSION is a separate axis and
  // both panes now carry it (`sectionVisible.groups` / `.roles`, from the
  // `group.read` / `role.read` probes): a caller who cannot read the list must
  // not get a rail item that opens onto "you don't have permission". What this
  // pins is that neither pane is swapped for an EnterpriseUpsell card — see
  // `accounts/[id]/account-hub-section-gating.test.ts` for the permission map.
  test('groups tab: no entitlement gate, passed rbacEnabled to gate its own controls', () => {
    expect(pageSource).toMatch(/activeSection === 'groups' && sectionVisible\.groups \?[\s\S]*?<GroupsTab/);
    expect(pageSource).toMatch(/<GroupsTab[\s\S]*?rbacEnabled=\{rbacEnabled\}/);
    expect(pageSource).not.toContain('<EnterpriseUpsell feature="groups" />');
  });

  test('roles tab: no entitlement gate, passed rbacEnabled to gate its own controls', () => {
    expect(pageSource).toMatch(/activeSection === 'roles' && sectionVisible\.roles \?[\s\S]*?<RolesTab/);
    expect(pageSource).toMatch(/<RolesTab[\s\S]*?rbacEnabled=\{rbacEnabled\}/);
    expect(pageSource).not.toContain('<EnterpriseUpsell feature="roles" />');
  });

  test('audit tab: auditAccess entitlement or upsell', () => {
    expect(pageSource).toContain('const auditEnabled = !!entitlements?.auditAccess');
    expect(pageSource).toMatch(/auditEnabled \? \(\s*<AuditTab/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="audit" />');
  });

  test('identity section: sso/scim entitlement or upsell (cards no longer just hidden)', () => {
    // A short "why connect both" explainer sits above the two cards — allow
    // it between the entitlement check and <SsoCard> while still asserting
    // SsoCard renders before ScimCard.
    expect(pageSource).toMatch(/enterpriseIdentityEnabled \? \([\s\S]*?<SsoCard[\s\S]*?<ScimCard/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="identity" />');
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
  test('the rail has a labeled Access group with every access surface in it', () => {
    const accessGroup = pageSource.match(/label: 'Access',\s*items: \[([\s\S]*?)\],\s*\},/);
    const groupBody = accessGroup?.[1] ?? '';
    expect(groupBody).not.toBe('');
    for (const id of ["'members'", "'groups'", "'roles'", "'identity'", "'audit'"]) {
      expect(groupBody).toContain(`id: ${id}`);
    }
  });

  test('the Enterprise nav group is gone', () => {
    expect(pageSource).not.toContain("label: 'Enterprise'");
  });

  test('identity is its own section, not buried in Settings', () => {
    expect(pageSource).toMatch(/activeSection === 'identity' && canWriteAccount/);
    const settingsStart = pageSource.indexOf("activeSection === 'settings' && canWriteAccount");
    expect(settingsStart).toBeGreaterThan(-1);
    const settingsEnd = pageSource.indexOf('</m.div>', settingsStart);
    const settingsBody = pageSource.slice(settingsStart, settingsEnd);
    // The connection cards (and the tokens-tab cards) still live only on
    // their own sections — SsoCard/ScimCard never move into Settings.
    for (const moved of ['SsoCard', 'ScimCard', 'PatPolicyCard']) {
      expect(settingsBody).not.toContain(moved);
    }
  });

  test('the enterprise-demo toggle moved OUT of Identity and INTO Settings (tucked away, not headline)', () => {
    const identityStart = pageSource.indexOf("activeSection === 'identity' && canWriteAccount");
    // The content pane's closing tag. It was `</m.div>` while the account page
    // built its own two-column layout inline; the pane is `SettingsShell`'s
    // now (`features/workspace/shared/settings-shell.tsx`), so the page's last
    // tag is the shell's. A boundary that no longer matches makes `indexOf`
    // return -1 and `slice(start, -1)` swallow the whole rest of the file,
    // which is how this test can only ever fail loudly — keep it a string the
    // page actually contains.
    const identityEnd = pageSource.indexOf('</SettingsShell>', identityStart);
    const settingsStart = pageSource.indexOf("activeSection === 'settings' && canWriteAccount");
    const identityBody = pageSource.slice(identityStart, Math.min(identityEnd, settingsStart));
    expect(identityBody).not.toContain('EnterpriseDemoCard');

    const settingsEnd = pageSource.indexOf('</m.div>', settingsStart);
    const settingsBody = pageSource.slice(settingsStart, settingsEnd);
    expect(settingsBody).toContain('EnterpriseDemoCard');
    // Placed above Danger zone, not at the top — tucked away.
    const demoIdx = settingsBody.indexOf('EnterpriseDemoCard');
    const dangerIdx = settingsBody.indexOf('Danger zone');
    expect(demoIdx).toBeGreaterThan(-1);
    expect(dangerIdx).toBeGreaterThan(-1);
    expect(demoIdx).toBeLessThan(dangerIdx);
  });

  test('the demo card + upsell are skipped entirely when a self-host Enterprise license already forces entitlements on', () => {
    expect(pageSource).toContain('accountStateQuery.data?.enterprise_license_available');
  });

  /**
   * `PatPolicyCard` + `ServiceAccountsCard` until 2026-08-12, when both were
   * replaced by the components the settings panel's API keys tab mounts. The
   * order flipped with them: the keys come first now, the rules that govern
   * them second — the same fix made in `tabs/api-keys-tab.tsx`, for the same
   * reason (a policy form is not what someone opening "Tokens" came for).
   */
  test('tokens section carries the keys list and then the key rules', () => {
    expect(pageSource).toMatch(/activeSection === 'tokens' && canWriteAccount/);
    expect(pageSource).toMatch(
      /activeSection === 'tokens'[\s\S]*?<ApiKeysSection[\s\S]*?<KeyRulesCard/,
    );
  });

  test('audit webhooks live on the audit tab, gated on entitlement + write', () => {
    expect(pageSource).toMatch(/auditEnabled && canWriteAccount \? \(\s*<AuditWebhooksCard/);
  });
});
