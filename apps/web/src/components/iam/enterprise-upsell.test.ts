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
  test('groups tab: rbac entitlement or upsell', () => {
    expect(pageSource).toMatch(/rbacEnabled \? \(\s*<GroupsTab/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="groups" />');
  });

  test('roles tab: rbac entitlement or upsell', () => {
    expect(pageSource).toMatch(/rbacEnabled \? \(\s*<RolesTab/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="roles" />');
  });

  test('audit tab: auditAccess entitlement or upsell', () => {
    expect(pageSource).toContain('const auditEnabled = !!entitlements?.auditAccess');
    expect(pageSource).toMatch(/auditEnabled \? \(\s*<AuditTab/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="audit" />');
  });

  test('identity section: sso/scim entitlement or upsell (cards no longer just hidden)', () => {
    expect(pageSource).toMatch(/enterpriseIdentityEnabled \? \(\s*<>\s*<SsoCard/);
    expect(pageSource).toContain('<EnterpriseUpsell feature="identity" />');
  });

  test('no upsell flash while entitlements load', () => {
    expect(pageSource).toContain('entitlementsLoading');
  });
});

describe('account page rail groups the enterprise surfaces', () => {
  test('the rail has a labeled Enterprise group with all four IAM sections', () => {
    const enterpriseGroup = pageSource.match(/label: 'Enterprise',\s*items: \[([\s\S]*?)\]/);
    const groupBody = enterpriseGroup?.[1] ?? '';
    expect(groupBody).not.toBe('');
    for (const id of ["'groups'", "'roles'", "'identity'", "'audit'"]) {
      expect(groupBody).toContain(`id: ${id}`);
    }
  });

  test('identity is its own section, not buried in Settings', () => {
    expect(pageSource).toMatch(/activeSection === 'identity' && canWriteAccount/);
    const settingsStart = pageSource.indexOf("activeSection === 'settings' && canWriteAccount");
    expect(settingsStart).toBeGreaterThan(-1);
    const settingsEnd = pageSource.indexOf('</motion.div>', settingsStart);
    const settingsBody = pageSource.slice(settingsStart, settingsEnd);
    for (const moved of ['SsoCard', 'ScimCard', 'EnterpriseDemoCard', 'PatPolicyCard']) {
      expect(settingsBody).not.toContain(moved);
    }
  });

  test('demo toggle stays outside the entitlement gate on the identity section', () => {
    expect(pageSource).toMatch(/<EnterpriseDemoCard[\s\S]*?\/>\s*\{entitlementsLoading/);
  });

  test('tokens section carries the PAT policy and service accounts cards', () => {
    expect(pageSource).toMatch(/activeSection === 'tokens' && canWriteAccount/);
    expect(pageSource).toMatch(
      /activeSection === 'tokens'[\s\S]*?<PatPolicyCard[\s\S]*?<ServiceAccountsCard/,
    );
  });

  test('audit webhooks live on the audit tab, gated on entitlement + write', () => {
    expect(pageSource).toMatch(/auditEnabled && canWriteAccount \? \(\s*<AuditWebhooksCard/);
  });
});
