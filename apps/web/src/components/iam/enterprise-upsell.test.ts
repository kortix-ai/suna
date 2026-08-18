// The IAM surfaces (Groups, Roles, Audit, SSO/SCIM) are enterprise-gated:
// non-entitled accounts must see the upsell card — with the "Request a demo"
// CTA — instead of the feature, on every one of the four surfaces. The CTA
// opens the in-app demo-request modal (useRequestDemo) rather than navigating
// out to the marketing page. Guards the page wiring so a refactor can't
// silently un-gate a tab.
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

  test('covers all four gated surfaces', () => {
    for (const feature of ['groups:', 'roles:', 'audit:', 'identity:']) {
      expect(upsellSource).toContain(feature);
    }
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
  test('groups tab: always mounted, passed rbacEnabled to gate its own controls', () => {
    expect(pageSource).toMatch(/activeSection === 'groups' \?[\s\S]*?<GroupsTab/);
    expect(pageSource).toMatch(/<GroupsTab[\s\S]*?rbacEnabled=\{rbacEnabled\}/);
    expect(pageSource).not.toContain('<EnterpriseUpsell feature="groups" />');
  });

  test('roles tab: always mounted, passed rbacEnabled to gate its own controls', () => {
    expect(pageSource).toMatch(/activeSection === 'roles' \?[\s\S]*?<RolesTab/);
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

describe('account page rail groups the enterprise surfaces', () => {
  // Members / Groups / Roles are one "Access" cluster — three facets of the
  // same access-control concern — instead of Members sitting alone at the
  // top disconnected from Groups/Roles below (2026-08-18 centralized-IAM
  // redesign). Identity/Audit stay under "Enterprise": unlike Members/
  // Groups/Roles they have zero free-tier content.
  test('the rail has a labeled Access group with members, groups, and roles', () => {
    const accessGroup = pageSource.match(/label: 'Access',\s*items: \[([\s\S]*?)\],\s*\},/);
    const groupBody = accessGroup?.[1] ?? '';
    expect(groupBody).not.toBe('');
    for (const id of ["'members'", "'groups'", "'roles'"]) {
      expect(groupBody).toContain(`id: ${id}`);
    }
  });

  test('the rail has a labeled Enterprise group with identity and audit', () => {
    const enterpriseGroup = pageSource.match(/label: 'Enterprise',\s*items: \[([\s\S]*?)\]/);
    const groupBody = enterpriseGroup?.[1] ?? '';
    expect(groupBody).not.toBe('');
    for (const id of ["'identity'", "'audit'"]) {
      expect(groupBody).toContain(`id: ${id}`);
    }
    // Groups/Roles moved OUT of Enterprise into Access — they have free
    // content (the built-in roles, an account's real group list), so a
    // heading that reads as plan-gated would mislabel them.
    for (const id of ["'groups'", "'roles'"]) {
      expect(groupBody).not.toContain(`id: ${id}`);
    }
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
    const identityEnd = pageSource.indexOf('</m.div>', identityStart);
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
