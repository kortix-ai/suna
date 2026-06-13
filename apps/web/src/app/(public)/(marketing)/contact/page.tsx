'use client';

import { useState } from 'react';
import {
  ArrowRight,
  PlayCircle,
  Server,
  Boxes,
  ShieldCheck,
  Lock,
  Clock,
  Mail,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DemoQualifierDialog } from '@/components/contact/demo-qualifier-dialog';

const CONTACT_EMAIL = 'hey@kortix.ai';

// Public demo event (cal.com/team/kortix/demo) + a namespace unique to it.
const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-enterprise-demo';

const VALUE_PROPS = [
  { icon: <PlayCircle className="size-4" />, title: 'A tailored walkthrough', desc: 'See agents run your actual workflows end-to-end — not a generic demo.' },
  { icon: <Server className="size-4" />, title: 'Deploy your way', desc: 'Managed cloud, your private VPC, or fully on-prem / air-gapped.' },
  { icon: <Boxes className="size-4" />, title: 'Batteries included', desc: '3,000+ integrations, 60+ skills, and agents pre-built for your industry.' },
  { icon: <ShieldCheck className="size-4" />, title: 'Enterprise-ready', desc: 'SSO, RBAC, audit logs, secrets manager — and open to audit.' },
  { icon: <Lock className="size-4" />, title: 'Yours to own', desc: 'Self-host, bring your own models, no vendor lock-in.' },
];

export default function ContactPage() {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative min-h-dvh overflow-hidden bg-background">
      {/* Soft top glow — keeps the page on-brand without the busy brandmark. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-muted/40 to-transparent" />

      <section className="relative z-[1] mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center px-6 py-32 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background/70 px-3 py-1 text-xs font-mono uppercase tracking-wider text-muted-foreground backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          Enterprise · on-prem available
        </div>

        <h1 className="mt-6 text-4xl font-medium leading-[1.04] tracking-tight text-foreground sm:text-5xl md:text-6xl">
          See Kortix run<br />
          <span className="text-muted-foreground">your company&apos;s work</span>
        </h1>

        <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          Book a 30-minute walkthrough with a solutions engineer — see agents run your
          real workflows, and get a deployment plan for your stack.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Button size="lg" className="h-12 rounded-full px-8 text-sm" onClick={() => setOpen(true)}>
            Book a demo<ArrowRight className="ml-1.5 size-3.5" />
          </Button>
          <Button asChild size="lg" variant="outline" className="h-12 rounded-full px-7 text-sm">
            <a href={`mailto:${CONTACT_EMAIL}`}>
              <Mail className="mr-1.5 size-4" />Email us
            </a>
          </Button>
        </div>

        <p className="mt-6 inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="size-4 text-foreground/60" />
          A solutions engineer replies within one business day.
        </p>

        {/* Value props — minimal list, balanced regardless of count. */}
        <div className="mx-auto mt-16 flex w-full max-w-md flex-col gap-5 text-left">
          {VALUE_PROPS.map(({ icon, title, desc }) => (
            <div key={title} className="flex items-start gap-3.5">
              <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center text-muted-foreground">
                {icon}
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">{title}.</span> {desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      <DemoQualifierDialog
        open={open}
        onOpenChange={setOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source="contact"
      />
    </div>
  );
}
