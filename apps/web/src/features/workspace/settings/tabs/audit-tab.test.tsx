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

/**
 * Pins the webhooks card's OWN, stricter gate — `page.tsx:573
 * !entitlementsLoading && auditEnabled && canWriteAccount` — folded in per
 * the coordinator's follow-up. The card sits INSIDE `auditEnabled`, same as
 * the log, but additionally needs `canWriteAccount`: entitled + writable
 * shows the log AND the card, entitled + read-only shows the log WITHOUT
 * the card. Neither entitlement state ever shows the card without the log.
 */
describe('AuditTabView — webhooks card gate', () => {
  test('entitled + writable renders both the audit log slot and the webhooks card', () => {
    const out = renderToStaticMarkup(
      <AuditTabView
        auditEnabled
        canWriteAccount
        auditSlot={<div>real-audit-content</div>}
        webhooksSlot={<div>real-webhooks-card</div>}
      />,
    );
    expect(out).toContain('real-audit-content');
    expect(out).toContain('real-webhooks-card');
  });

  test('entitled + read-only renders the log but NOT the webhooks card', () => {
    const out = renderToStaticMarkup(
      <AuditTabView
        auditEnabled
        canWriteAccount={false}
        auditSlot={<div>real-audit-content</div>}
        webhooksSlot={<div>real-webhooks-card</div>}
      />,
    );
    expect(out).toContain('real-audit-content');
    expect(out).not.toContain('real-webhooks-card');
  });

  test('non-entitled + writable renders neither the log nor the webhooks card — just the upsell', () => {
    const out = renderToStaticMarkup(
      <AuditTabView
        auditEnabled={false}
        canWriteAccount
        auditSlot={<div>real-audit-content</div>}
        webhooksSlot={<div>real-webhooks-card</div>}
      />,
    );
    expect(out).toContain('Audit logs are an Enterprise feature');
    expect(out).not.toContain('real-audit-content');
    expect(out).not.toContain('real-webhooks-card');
  });

  test('loading + writable renders neither the log, the upsell, nor the webhooks card — a skeleton only', () => {
    const out = renderToStaticMarkup(
      <AuditTabView
        isLoading
        auditEnabled
        canWriteAccount
        auditSlot={<div>real-audit-content</div>}
        webhooksSlot={<div>real-webhooks-card</div>}
      />,
    );
    expect(out).not.toContain('real-audit-content');
    expect(out).not.toContain('real-webhooks-card');
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('defaults (no props) render neither slot — canWriteAccount defaults to false', () => {
    const out = renderToStaticMarkup(
      <AuditTabView auditEnabled webhooksSlot={<div>real-webhooks-card</div>} />,
    );
    expect(out).not.toContain('real-webhooks-card');
  });
});
