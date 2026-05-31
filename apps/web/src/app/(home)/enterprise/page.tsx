'use client';

import Link from 'next/link';

import { Button } from '@/components/ui/marketing/button';
import { EnterpriseCalModal } from '@/features/enterprise/cal-modal';
import { useState } from 'react';

const CAPABILITIES = [
  {
    title: 'SAML SSO',
    description:
      'Okta, Azure AD, or any SAML provider. JIT provisioning with group sync from your directory.',
  },
  {
    title: 'SCIM 2.0',
    description:
      'Automated user and group provisioning. Per-account bearer tokens, hashed at rest.',
  },
  {
    title: 'Advanced RBAC',
    description:
      'Account and project roles, manual or SCIM-sourced groups, and policy-based grants.',
  },
  {
    title: 'Executor policies',
    description: 'Every tool call passes through guardrails — run, require approval, or block.',
  },
  {
    title: 'Audit & export',
    description: 'Full audit log with CSV/JSONL export and signed webhooks for your SIEM.',
  },
  {
    title: 'Isolated sandboxes',
    description:
      'Sessions run in ephemeral sandboxes. Credentials resolve server-side, never exposed.',
  },
] as const;

const DEPLOYMENT = [
  { label: 'Managed cloud', detail: 'Hosted & maintained by Kortix' },
  { label: 'Private VPC', detail: 'Single-tenant in your cloud' },
  { label: 'On-prem / air-gapped', detail: 'Fully isolated, your infrastructure' },
  { label: 'Security review & DPA', detail: 'Part of the onboarding process' },
] as const;

const EnterprisePage = () => {
  const [calOpen, setCalOpen] = useState(false);

  return (
    <main className="bg-background relative py-28 antialiased sm:py-40">
      <div className="mx-auto max-w-6xl px-6 lg:px-0">
        <section className="col-span-5 w-full">
          <p className="text-muted-foreground font-kerning-normal font-mono text-xs tracking-[0.2em] uppercase">
            Enterprise
          </p>
          <h1 className="text-foreground mt-5 text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            The agent platform for teams that need control.
          </h1>
          <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
            SAML, SCIM, audit, and policy guardrails — deployed in our cloud, your VPC, or fully
            on-prem. Custom pricing, dedicated support, and an SLA.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="lg" onClick={() => setCalOpen(true)}>
              Request a demo
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/pricing">Compare plans</Link>
            </Button>
          </div>
        </section>

        {/* <div className="bg-card/40 mx-auto max-w-xl rounded-md border p-6">
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Request a Demo</h2>
                  <p className="text-muted-foreground text-sm">
                    Tell us about your company and workflow.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="name">Full Name</Label>
                    <Input
                      id="name"
                      value={form.name}
                      onChange={set('name')}
                      placeholder="Jane Doe"
                      required
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="email">Work Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={set('email')}
                      placeholder="jane@company.com"
                      required
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="company">Company</Label>
                    <Input
                      id="company"
                      value={form.company}
                      onChange={set('company')}
                      placeholder="Acme Inc."
                      required
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="role">Role</Label>
                    <Input
                      id="role"
                      value={form.role}
                      onChange={set('role')}
                      placeholder="Head of Operations"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="size">Company Size</Label>
                    <Select value={form.size || undefined} onValueChange={setSelect('size')}>
                      <SelectTrigger id="size" className="h-11 w-full">
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        {COMPANY_SIZES.map((size) => (
                          <SelectItem key={size} value={size}>
                            {size}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="deployment">Deployment</Label>
                    <Select
                      value={form.deployment || undefined}
                      onValueChange={setSelect('deployment')}
                    >
                      <SelectTrigger id="deployment" className="h-11 w-full">
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        {DEPLOYMENT_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="goal">What would you like to automate?</Label>
                  <Textarea
                    id="goal"
                    value={form.goal}
                    onChange={set('goal')}
                    rows={4}
                    placeholder="Describe your workflow..."
                  />
                </div>

                <Button type="submit" size="lg" className="w-full">
                  Request Demo
                  <ArrowRight className="ml-2 size-4" />
                </Button>
              </form>
            </div> */}
        {/* </section> */}

        <section className="border-border mt-24 border-t pt-16">
          <h2 className="text-muted-foreground text-sm font-medium tracking-wider uppercase">
            Capabilities
          </h2>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {CAPABILITIES.map(({ title, description }) => (
              <div key={title} className="bg-card flex flex-col rounded p-4">
                <h3 className="text-foreground text-base font-medium">{title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-border mt-24 border-t pt-16">
          <h2 className="text-muted-foreground text-sm font-medium tracking-wider uppercase">
            Deployment
          </h2>
          <dl className="divide-border border-border mt-8 divide-y border-y">
            {DEPLOYMENT.map(({ label, detail }) => (
              <div key={label} className="flex items-baseline justify-between py-4">
                <dt className="text-foreground text-base font-medium">{label}</dt>
                <dd className="text-muted-foreground text-sm">{detail}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <EnterpriseCalModal open={calOpen} onOpenChange={setCalOpen} />
    </main>
  );
};

export default EnterprisePage;
