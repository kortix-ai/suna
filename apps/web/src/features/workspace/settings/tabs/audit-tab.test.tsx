import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AuditTabView } from './audit-tab';

/**
 * Pins the entitlement gate `AuditTabView` implements — see this tab's
 * header comment for the exact `file:line` this mirrors
 * (`app/(app)/accounts/[id]/page.tsx:309,363,561-577`). The whole-tab
 * `audit.read` gate lives in `AuditTabInner` (the container), which calls
 * `useAuth`/`usePermission`/`useQuery` and therefore can't render under
 * `renderToStaticMarkup` with no providers mounted — same reason
 * `identity-tab.test.tsx` never renders `IdentityTab` directly, only
 * `IdentityTabView`.
 */
describe('AuditTabView', () => {
  test('entitled renders the real audit log slot, not the upsell or a skeleton', () => {
    const out = renderToStaticMarkup(
      <AuditTabView auditEnabled auditSlot={<div>real-audit-content</div>} />,
    );
    expect(out).toContain('real-audit-content');
    expect(out).not.toContain('Enterprise feature');
  });

  test('non-entitled renders EnterpriseUpsell in place of the pane — this view still renders content, not nothing', () => {
    const out = renderToStaticMarkup(
      <AuditTabView auditEnabled={false} auditSlot={<div>real-audit-content</div>} />,
    );
    expect(out).toContain('Audit logs are an Enterprise feature');
    expect(out).not.toContain('real-audit-content');
  });

  test('loading renders neither the slot nor the upsell — a skeleton only', () => {
    const out = renderToStaticMarkup(
      <AuditTabView isLoading auditEnabled auditSlot={<div>real-audit-content</div>} />,
    );
    expect(out).not.toContain('real-audit-content');
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('loading wins even when auditEnabled is false — never flashes the upsell while still resolving', () => {
    const out = renderToStaticMarkup(<AuditTabView isLoading auditEnabled={false} />);
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('defaults (no props) render the non-entitled upsell, not a crash', () => {
    const out = renderToStaticMarkup(<AuditTabView />);
    expect(out).toContain('Audit logs are an Enterprise feature');
  });
});
