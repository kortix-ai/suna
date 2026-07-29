'use client';

import {
  CtaSection,
  FaqSection,
  HeroSection,
  SplitSection,
} from '@/features/marketing/v2/page-kit';
import { ChecklistSplit, ComplianceNote, TruthGrid } from '@/features/marketing/v2/trust-sections';

/**
 * The page a security questionnaire gets answered from, so it is composed by
 * hand rather than run through the generic section dispatcher: the guarantees
 * are numbered, the compliance block leads with the audit status, and the only
 * product visual is the real connectors screenshot.
 */
export default function SecurityPage() {
  return (
    <main className="bg-background">
      <HeroSection
        id="hero"
        heading="Agents work on your company. You stay in control."
        body="From sandbox isolation to scoped credentials, approval gates, and deployment controls, every layer is designed to keep your data, your config, and your decisions yours."
        visual="slabs"
      />

      <TruthGrid
        id="four-truths"
        heading="Four things that are true of every session."
        body="No exceptions, no tiers, no setting to forget."
        columns={2}
        items={[
          'It runs in its own machine. A microVM-isolated Linux sandbox, provisioned for the run and destroyed after it.',
          'It runs on its own branch. Work never lands directly on main. It arrives as a diff someone can read and reject.',
          'It carries scoped credentials. Secrets are injected into the sandbox at runtime and are never part of the prompt.',
          'It is written down. Who started it, what it touched, what it produced, and who approved it.',
        ]}
      />

      <ChecklistSplit
        id="approval"
        tone="muted"
        heading="A person approves every merge."
        body="Kortix does not ship on your behalf. Every run ends in a change request: a diff, an artifact, or a document that a person reviews, iterates on, and approves before anything reaches main."
        bullets={[
          'Approval gates are part of the model, not a preference',
          'Reviewers are real members with real roles',
          'A rejection sends the session back with context',
          'Every decision lands in the audit trail',
        ]}
      />

      <SplitSection
        id="reach"
        heading="One scoped token, and nothing else."
        body="Your API keys never enter a sandbox. Agents act through a single scoped Kortix token, and reach is declared per agent and per tool with allow, ask first, or block rules — down to network-level patterns. Rotate one credential to revoke everything, everywhere."
        bullets={[
          'Credentials are brokered server-side and never copied into a session',
          'Approval rules that gate every tool live in config, reviewable as a diff',
          'Egress policy is set per project',
          'Adding reach is a change request like any other',
        ]}
        visual="/images/landing-showcase/platform/03-connectors.png"
      />

      <ComplianceNote
        id="compliance"
        eyebrow="Compliance"
        status="Audit in progress"
        heading="SOC 2 Type II — in progress."
        body="Our SOC 2 Type II audit is underway. The controls it measures — isolated execution, scoped credentials, complete audit trails, access management — are already how Kortix is built, not retrofits. Security review documentation is available on request."
        link={{ label: 'Request documentation', href: '/v2/contact' }}
      />

      <ChecklistSplit
        id="self-host"
        tone="muted"
        heading="Or run the whole thing yourself."
        body="If the strongest control is that the data never leaves, self-host Kortix inside your own VPC, on-prem, or in a fully air-gapped network. Same agents, same skills, same connectors."
        bullets={[
          'Your infrastructure, your keys',
          'Your choice of model provider',
          'Open source, auditable end to end',
          'No phone-home requirement',
        ]}
        link={{ label: 'How self-hosting works', href: '/v2/self-hosted' }}
      />

      <FaqSection
        id="faq"
        heading="Questions your security team asks."
        body="The short answers. The long ones are available under NDA."
        bullets={[
          'Does the model ever see our secrets? No. Secrets are encrypted, scoped per agent, and injected into the sandbox process environment at runtime. They are never rendered into a prompt or returned to the model.',
          'Can one agent affect another? No. Each session gets its own microVM with its own filesystem and its own branch. There is no shared writable state between concurrent runs.',
          'What can an agent reach? Only the connectors granted to it, through one scoped token, plus whatever egress policy the project allows. Reach is declared in kortix.yaml and reviewable like any other config.',
          'Can agents merge to main on their own? No. Work lands as a change request that a person has to approve. That gate is part of the product, not a preference.',
          'Where does our data live? On Kortix Cloud, in the region you pick. Self-hosted, entirely inside your own environment — including air-gapped networks with no public internet access.',
        ]}
      />

      <CtaSection
        id="cta"
        heading="Read the details, then ask us anything."
        body="The isolation architecture, our subprocessor list, and security review documentation are available on request."
      />
    </main>
  );
}
