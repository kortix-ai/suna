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
const pageSource = readFileSync(
  join(dir, '../../app/(app)/accounts/[id]/page.tsx'),
  'utf8',
);

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
