'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { useState, useCallback } from 'react';
import {
  ArrowRight,
  Check,
  PlayCircle,
  Server,
  Boxes,
  ShieldCheck,
  Lock,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

const CONTACT_EMAIL = 'hey@kortix.ai';

const VALUE_PROPS = [
  { icon: <PlayCircle className="size-4" />, title: 'A tailored walkthrough', desc: 'See agents run your actual workflows end-to-end — not a generic demo.' },
  { icon: <Server className="size-4" />, title: 'Deploy your way', desc: 'Managed cloud, your private VPC, or fully on-prem / air-gapped.' },
  { icon: <Boxes className="size-4" />, title: 'Batteries included', desc: '3,000+ integrations, 60+ skills, and agents pre-built for your industry.' },
  { icon: <ShieldCheck className="size-4" />, title: 'Enterprise-ready', desc: 'SSO, RBAC, audit logs, secrets manager — and source-available to audit.' },
  { icon: <Lock className="size-4" />, title: 'Yours to own', desc: 'Self-host, bring your own models, no vendor lock-in.' },
];

const FIELD = 'h-11 rounded-xl bg-card/40';

export default function EnterprisePage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', company: '', size: '', role: '', deployment: '', goal: '' });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      // MVP capture via email. TODO: wire to CRM / lead endpoint.
      const subject = `Demo request — ${form.company || form.name || 'Kortix'}`;
      const body = [
        `Name: ${form.name}`,
        `Work email: ${form.email}`,
        `Company: ${form.company}`,
        `Company size: ${form.size}`,
        `Role: ${form.role}`,
        `Deployment interest: ${form.deployment}`,
        '',
        'What they want to automate:',
        form.goal,
      ].join('\n');
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      setSubmitted(true);
    },
    [form],
  );

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

          {/* ─── Right: form ─── */}
          <div className="rounded-3xl border border-border bg-card/40 p-6 sm:p-8 shadow-sm lg:sticky lg:top-28">
            {submitted ? (
              <div className="flex flex-col items-center text-center py-10">
                <div className="flex items-center justify-center size-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 mb-5">
                  <Check className="size-6" />
                </div>
                <h2 className="text-xl font-medium tracking-tight text-foreground">Thanks{form.name ? `, ${form.name.split(' ')[0]}` : ''}{tHardcodedUi.raw('appHomeEnterprisePage.line105JsxTextRequestReceived')}</h2>
                <p className="mt-2 text-sm text-muted-foreground max-w-sm">{tHardcodedUi.raw('appHomeEnterprisePage.line107JsxTextWeAposLlReachOutAt')}<span className="text-foreground font-medium">{form.email || 'your email'}</span>{tHardcodedUi.raw('appHomeEnterprisePage.line107JsxTextWithinOneBusinessDayIfYourMailClient')}{' '}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4">{CONTACT_EMAIL}</a>.
                </p>
                <Button variant="outline" className="mt-6 rounded-full" onClick={() => setSubmitted(false)}>{tHardcodedUi.raw('appHomeEnterprisePage.line110JsxTextSubmitAnotherRequest')}</Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{tHardcodedUi.raw('appHomeEnterprisePage.line115JsxTextRequestADemo')}</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">{tHardcodedUi.raw('appHomeEnterprisePage.line116JsxTextTellUsABitAboutYouAndWhat')}</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="name" className="text-sm">{tHardcodedUi.raw('appHomeEnterprisePage.line121JsxTextFullName')}</Label>
                    <Input id="name" value={form.name} onChange={set('name')} required placeholder={tHardcodedUi.raw('appHomeEnterprisePage.line122JsxAttrPlaceholderJaneDoe')} className={FIELD} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="email" className="text-sm">{tHardcodedUi.raw('appHomeEnterprisePage.line125JsxTextWorkEmail')}</Label>
                    <Input id="email" type="email" value={form.email} onChange={set('email')} required placeholder={tHardcodedUi.raw('appHomeEnterprisePage.line126JsxAttrPlaceholderJaneCompanyCom')} className={FIELD} />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="company" className="text-sm">Company</Label>
                    <Input id="company" value={form.company} onChange={set('company')} required placeholder={tHardcodedUi.raw('appHomeEnterprisePage.line133JsxAttrPlaceholderAcmeInc')} className={FIELD} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="role" className="text-sm">Role <span className="text-muted-foreground font-normal">(optional)</span></Label>
                    <Input id="role" value={form.role} onChange={set('role')} placeholder={tHardcodedUi.raw('appHomeEnterprisePage.line137JsxAttrPlaceholderHeadOfOperations')} className={FIELD} />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="size" className="text-sm">{tHardcodedUi.raw('appHomeEnterprisePage.line143JsxTextCompanySize')}</Label>
                    <select id="size" value={form.size} onChange={set('size')} required className={cn(FIELD, 'w-full border border-input px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50')}>
                      <option value="" disabled>{tHardcodedUi.raw('appHomeEnterprisePage.line145JsxTextSelect')}</option>
                      <option>1–10</option>
                      <option>11–50</option>
                      <option>51–200</option>
                      <option>201–1,000</option>
                      <option>1,000+</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="deployment" className="text-sm">{tHardcodedUi.raw('appHomeEnterprisePage.line154JsxTextDeploymentInterest')}</Label>
                    <select id="deployment" value={form.deployment} onChange={set('deployment')} required className={cn(FIELD, 'w-full border border-input px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50')}>
                      <option value="" disabled>{tHardcodedUi.raw('appHomeEnterprisePage.line156JsxTextSelect')}</option>
                      <option>{tHardcodedUi.raw('appHomeEnterprisePage.line157JsxTextManagedCloud')}</option>
                      <option>{tHardcodedUi.raw('appHomeEnterprisePage.line158JsxTextPrivateCloudVpc')}</option>
                      <option>{tHardcodedUi.raw('appHomeEnterprisePage.line159JsxTextOnPremAirGapped')}</option>
                      <option>{tHardcodedUi.raw('appHomeEnterprisePage.line160JsxTextNotSureYet')}</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="goal" className="text-sm">{tHardcodedUi.raw('appHomeEnterprisePage.line166JsxTextWhatWouldYouLikeToAutomate')}</Label>
                  <Textarea id="goal" value={form.goal} onChange={set('goal')} rows={4} placeholder={tHardcodedUi.raw('appHomeEnterprisePage.line167JsxAttrPlaceholderEGDueDiligenceResearchSupportTicketsFinancial')} className="bg-card/40 resize-none" />
                </div>

                <Button type="submit" size="lg" className="h-12 w-full rounded-xl text-sm mt-1">{tHardcodedUi.raw('appHomeEnterprisePage.line171JsxTextRequestDemo')}<ArrowRight className="ml-1.5 size-3.5" />
                </Button>
                <p className="text-xs text-muted-foreground text-center">{tHardcodedUi.raw('appHomeEnterprisePage.line173JsxTextNoSpamWeOnlyUseThisToPrepare')}</p>
              </form>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
