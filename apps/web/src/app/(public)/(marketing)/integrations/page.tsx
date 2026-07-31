import { AuditSection } from '@/features/marketing/integrations/audit-section';
import { BrokerSection } from '@/features/marketing/integrations/broker-section';
import { CloseSection } from '@/features/marketing/integrations/close-section';
import { ConnectSection } from '@/features/marketing/integrations/connect-section';
import { IntegrationsHero } from '@/features/marketing/integrations/hero';
import { PolicySection } from '@/features/marketing/integrations/policy-section';
import { ScopeSection } from '@/features/marketing/integrations/scope-section';
import type { ReactNode } from 'react';

/**
 * /integrations — the connectors page.
 *
 * The route is /integrations because that is the word people search for. The
 * copy on it never uses "integration" as a noun; the product noun is
 * "connector" (the `comms` skill, §7).
 *
 * The arc, in order: every action is allowed, gated, or blocked → connect once →
 * the credential never reaches the agent → reach is scoped → everything is
 * written down.
 *
 * POLICY IS SECOND, DELIBERATELY (moved 2026-07-31). It used to sit fourth,
 * after connect / broker / scope, which is the order the plumbing happens in but
 * not the order a reader cares about. Granting an agent real reach into a real
 * tool is the thing people hesitate over, and the answer to it — you set allow,
 * ask or block on every single action, and a rule can match on the arguments —
 * is the strongest thing this page has. It now lands in the first screenful,
 * with the real Permissions capture as the first product shot on the page.
 * Everything after it explains how that control is delivered.
 */
export default function IntegrationsPage(): ReactNode {
  return (
    <div className="bg-background relative">
      <IntegrationsHero />
      <PolicySection />
      <ConnectSection />
      <BrokerSection />
      <ScopeSection />
      <AuditSection />
      <CloseSection />
      <div className="h-24 sm:h-28" />
    </div>
  );
}
