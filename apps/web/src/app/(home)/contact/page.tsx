'use client';

import { useTranslations } from 'next-intl';

import { useEffect } from 'react';
import {
  PlayCircle,
  Server,
  Boxes,
  ShieldCheck,
  Lock,
  Clock,
} from 'lucide-react';
import Cal, { getCalApi } from '@calcom/embed-react';

const CONTACT_EMAIL = 'hey@kortix.ai';

// Kortix team "demo" event (cal.com/team/kortix/demo). A dedicated namespace
// keeps this embed's UI config isolated from the in-app onboarding embeds.
const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-demo';

const VALUE_PROPS = [
  { icon: <PlayCircle className="size-4" />, title: 'A tailored walkthrough', desc: 'See agents run your actual workflows end-to-end — not a generic demo.' },
  { icon: <Server className="size-4" />, title: 'Deploy your way', desc: 'Managed cloud, your private VPC, or fully on-prem / air-gapped.' },
  { icon: <Boxes className="size-4" />, title: 'Batteries included', desc: '3,000+ integrations, 60+ skills, and agents pre-built for your industry.' },
  { icon: <ShieldCheck className="size-4" />, title: 'Enterprise-ready', desc: 'SSO, RBAC, audit logs, secrets manager — and source-available to audit.' },
  { icon: <Lock className="size-4" />, title: 'Yours to own', desc: 'Self-host, bring your own models, no vendor lock-in.' },
];

export default function ContactPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');

  useEffect(() => {
    (async function () {
      const cal = await getCalApi({ namespace: CAL_NAMESPACE });
      cal('ui', { hideEventTypeDetails: false, layout: 'month_view' });
    })();
  }, []);

  return (
    <div className="relative bg-background pt-28 sm:pt-32">
      <section className="max-w-6xl mx-auto px-6 pb-20 sm:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] gap-10 lg:gap-16 items-start">

          {/* ─── Left: sell ─── */}
          <div className="lg:pt-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-card/60 text-xs font-mono uppercase tracking-wider text-muted-foreground mb-6">
              <span className="size-1.5 rounded-full bg-emerald-500" />{tHardcodedUi.raw('appHomeEnterprisePage.line70JsxTextEnterpriseReadyBatteriesIncludedOnPremAvailable')}</div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-medium tracking-tight text-foreground leading-[1.04]">{tHardcodedUi.raw('appHomeEnterprisePage.line73JsxTextSeeKortixRun')}<br />
              <span className="text-muted-foreground">{tHardcodedUi.raw('appHomeEnterprisePage.line74JsxTextYourCompanyAposSWork')}</span>
            </h1>
            <p className="mt-5 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-lg">{tHardcodedUi.raw('appHomeEnterprisePage.line77JsxTextBookA30MinuteWalkthroughWithASolutions')}</p>

            <div className="mt-9 flex flex-col gap-4">
              {VALUE_PROPS.map(({ icon, title, desc }) => (
                <div key={title} className="flex items-start gap-3.5">
                  <div className="mt-0.5 flex items-center justify-center size-9 rounded-lg bg-foreground/[0.06] border border-foreground/10 text-foreground/80 shrink-0">{icon}</div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">{title}</div>
                    <div className="text-sm text-muted-foreground leading-relaxed">{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-9 flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="size-4 text-foreground/60" />{tHardcodedUi.raw('appHomeEnterprisePage.line94JsxTextASolutionsEngineerRepliesWithinOneBusinessDay')}</div>
          </div>

          {/* ─── Right: Cal.com inline booking — prospects self-book a slot so no lead is ever lost. ─── */}
          <div className="lg:sticky lg:top-28">
            <div className="rounded-3xl border border-border bg-card/40 p-2 shadow-sm overflow-hidden">
              <div className="h-[640px] overflow-hidden rounded-[1.4rem]">
                <Cal
                  namespace={CAL_NAMESPACE}
                  calLink={CAL_LINK}
                  style={{ width: '100%', height: '100%' }}
                  config={{ layout: 'month_view' }}
                />
              </div>
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Prefer email?{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4">{CONTACT_EMAIL}</a>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
