'use client';

import {
  CtaSection,
  GridSection,
  HeroSection,
  ListSection,
  SplitSection,
} from '@/features/marketing/v2/page-kit';
import { AnswerRows } from '@/features/marketing/v2/trust-sections';

/**
 * Written for the review board and the procurement checklist, so the middle of
 * the page is a scannable answer sheet rather than another card wall. The only
 * product visual is the real team screenshot; nothing here claims a
 * certification, a customer, or a metric.
 */
export default function EnterprisePage() {
  return (
    <main className="bg-background">
      <HeroSection
        id="hero"
        heading="Your whole company in one repo. Governed for the enterprise."
        body="Every agent, permission, connector, and secret is a file you control — reviewable, reversible, and deployable to Kortix Cloud, your own VPC, or your own metal. SSO · RBAC · Audit logs · Self-host · Open source."
        visual="slabs"
      />

      <ListSection
        id="govern-actions"
        heading="Govern actions, not just people."
        body="Most platforms stop at login. Kortix governs every tool call, secret read, and config change an agent makes — because the entire control plane is a git repo."
        bullets={[
          'One token, zero exposed secrets. Every connector and model is proxied through a single scoped Kortix token: rotated instantly, revoked in one click. Thirty credentials become one.',
          'Permissions down to the network. Each agent gets only the tools, secrets, and files it needs, with allow, ask first, or block rules per action. Risky operations pause for human sign-off before they run.',
          'Every change is a commit. Policy, agents, and config live in kortix.yaml inside a git repo. Every modification — by a person, an admin, or an agent — is a diff.',
        ]}
      />

      <SplitSection
        id="identity"
        tone="muted"
        heading="Who can do what, synced from your directory."
        body="People and agents are both principals in the same model. Bring your identity provider, let groups follow the org chart, and scope permissions per project and per resource."
        bullets={[
          'SAML SSO — sign in with your existing identity provider.',
          'SCIM provisioning — sync people and groups automatically, including Okta, Microsoft Entra, and JumpCloud.',
          'Advanced RBAC — roles and per-resource permissions, scoped per agent.',
          'Project access — owners, managers, editors, and members, invited by email or inherited from a group.',
        ]}
        visual="/images/product/members.png"
      />

      <SplitSection
        id="isolation"
        reversed
        heading="Isolation is the default, not a tier."
        body="Every session runs in a microVM-isolated Linux machine that is destroyed when the run ends. Thousands of agents can run in parallel on the same config with zero crossover, and nothing survives except the change request."
        bullets={[
          'microVM isolation per session',
          'No shared writable state between runs',
          'Egress and credentials controlled at the network',
          'Secrets injected at runtime, never reaching the model',
        ]}
        visual="slabs"
      />

      <AnswerRows
        id="runtime-audit"
        tone="muted"
        heading="What ran, where, and who approved it."
        body="Everything procurement asks for, answered in one place."
        columns={3}
        items={[
          { term: 'Full audit export', detail: 'Stream every agent action to your SIEM.' },
          {
            term: 'LLM gateway',
            detail:
              'One endpoint for every model, with budget controls and full observability. Bring your own keys or subscriptions.',
          },
          {
            term: 'Approval gates',
            detail: 'Every change request needs a person before it merges.',
          },
          {
            term: 'Encrypted secrets',
            detail: 'Injected at runtime through the token proxy, never visible to the model.',
          },
          {
            term: 'SOC 2 Type II — in progress',
            detail: 'The audit is underway; documentation is available on request.',
          },
          {
            term: 'SLA and DPA',
            detail: 'Named contact, onboarding, and a support agreement.',
          },
        ]}
        link={{ label: 'How the isolation model works', href: '/v2/security' }}
      />

      <GridSection
        id="deployment"
        heading="Your data never has to leave."
        body="Kortix is open source, and the same stack runs everywhere. You own every config, every session, and every byte of context. No data lock-in, ever."
        columns={3}
        bullets={[
          'Kortix Cloud. We run it. You own the config and the data.',
          'Private VPC. The full platform inside your own cloud account.',
          'On-prem and air-gapped. Fully isolated, on your own metal, with no outbound requirement.',
        ]}
      />

      <CtaSection
        id="cta"
        heading="Bring it to your security review."
        body="Bring one workflow, your deployment constraints, and your hardest security question. We will walk your team through the isolation model, the permission model, and the deployment options — usually in one call."
      />
    </main>
  );
}
