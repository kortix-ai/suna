import { ConnectorsHeroVisual } from '@/features/marketing/connectors/hero-visual';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import { AuditSection } from '@/features/marketing/connectors/audit-section';
import { BrokerSection } from '@/features/marketing/connectors/broker-section';
import { ConnectSection } from '@/features/marketing/connectors/connect-section';
import { hero } from '@/features/marketing/connectors/content';
import { PolicySection } from '@/features/marketing/connectors/policy-section';
import { ScopeSection } from '@/features/marketing/connectors/scope-section';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * /connectors — the connectors page.
 *
 * The route and product noun are both `connector` (the `comms` skill, §7).
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
interface ConnectorsPageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

export default async function ConnectorsPage({
  searchParams,
}: ConnectorsPageProps): Promise<ReactNode> {
  const query = await searchParams;
  if (query.connected === 'true' || query.error === 'true') {
    const result = new URLSearchParams();
    if (query.connected === 'true') result.set('connected', 'true');
    if (query.error === 'true') result.set('error', 'true');
    redirect(`/connections?${result.toString()}`);
  }

  return (
    <div className="bg-background relative">
      <CapabilityHero
        eyebrow={hero.eyebrow}
        title={hero.title}
        sub={hero.sub}
        ctaPrimary={hero.ctaPrimary}
        ctaPrimaryHref={hero.ctaPrimaryHref}
        ctaSecondary={hero.ctaSecondary}
        ctaSecondaryHref={hero.ctaSecondaryHref}
        visual={<ConnectorsHeroVisual />}
      />
      <PolicySection />
      <ConnectSection />
      <BrokerSection />
      <ScopeSection />
      <AuditSection />
    </div>
  );
}
