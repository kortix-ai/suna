/**
 * Pure onboarding logic — no React, no network, no DOM.
 *
 * Everything the wizard decides that does not need to render lives here so it
 * can be asserted directly instead of through a mounted component.
 */

import { emailDomain, isWorkEmail } from '@/lib/personal-email';
import type { OnboardingUseCase } from '@kortix/sdk';

/**
 * Three questions, then the project. Nothing here signs in to anything:
 * `apps` only declares connectors, and the first chat connects them in one
 * click each.
 */
export type StepId = 'work' | 'apps' | 'models';

/**
 * The work question's answers, in grid order (two columns, read row by row).
 * `hr_recruiting` stays a valid stored value for older projects but is not
 * offered: recruiting reads as "Something else" plus a typed note.
 */
export const WORK_OPTIONS: readonly OnboardingUseCase[] = [
  'founder',
  'engineering',
  'product_design',
  'sales',
  'marketing',
  'finance_ops',
  'support',
  'other',
];

/** The API keeps 120 characters of the "Something else" note. */
export const USE_CASE_NOTE_MAX = 120;

const ALL_STEPS: readonly StepId[] = ['work', 'apps', 'models'];

/**
 * Two reasons the apps step is dropped, and they are different questions:
 *
 *  - `connectorsEnabled` — is there a catalogue at all? A self-host without a
 *    connector provider (`isConnectorsEnabled()` false) has nothing to offer.
 *  - `canReadConnectors` — may THIS caller reach it? `project.connector.read`
 *    left the member floor role in #6522, so a plain project member would hit
 *    a 403 on the catalogue.
 *
 * Pass `canReadConnectors` false only on a RECEIVED denial — an in-flight probe
 * must not silently shorten the wizard for someone who does hold the leaf.
 */
export function buildSteps(connectorsEnabled: boolean, canReadConnectors = true): StepId[] {
  return ALL_STEPS.filter((id) => id !== 'apps' || (connectorsEnabled && canReadConnectors));
}

/**
 * Prefill for the company-domain field.
 *
 * Consumer inboxes yield `''` so we never suggest `gmail.com` as somebody's
 * employer. A single-label host (`localhost`) yields `''` too: `isWorkEmail`
 * only denylists known consumer providers, so it would otherwise wave it
 * through.
 */
export function deriveCompanyDomain(email: string | null | undefined): string {
  if (!isWorkEmail(email)) return '';
  const domain = emailDomain(email);
  if (!domain || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return '';
  }
  return domain;
}

export interface StarterPrompt {
  /** The matching template under `apps/web/content/use-cases/`. */
  template: string;
  title: string;
  prompt: string;
}

/**
 * Every template named here already exists in `apps/web/content/use-cases/`.
 * Nothing is invented — the finish step offers work the product demonstrably
 * does.
 */
const STARTER_PROMPTS: Record<OnboardingUseCase, StarterPrompt[]> = {
  founder: [
    {
      template: 'investor-update',
      title: 'Draft the investor update',
      prompt: 'Draft this month’s investor update from our metrics, wins, and asks.',
    },
    {
      template: 'weekly-report',
      title: 'Write the weekly report',
      prompt: 'Summarize what shipped, what slipped, and what is next across the team this week.',
    },
    {
      template: 'saas-spend-audit',
      title: 'Audit software spend',
      prompt: 'List every software subscription we pay for and flag the ones nobody uses.',
    },
  ],
  product_design: [
    {
      template: 'user-feedback',
      title: 'Sort user feedback',
      prompt:
        'Group this month’s user feedback into themes and rank them by how often they come up.',
    },
    {
      template: 'release-notes',
      title: 'Write release notes',
      prompt: 'Turn the changes merged since the last release into customer-facing release notes.',
    },
    {
      template: 'competitor-watch',
      title: 'Watch competitors',
      prompt: 'Check our top three competitors for product and pricing changes this month.',
    },
  ],
  sales: [
    {
      template: 'lead-follow-up',
      title: 'Follow up on new leads',
      prompt:
        'Research every new inbound lead from this week and draft a personalized follow-up email for each one.',
    },
    {
      template: 'outbound-outreach',
      title: 'Draft outbound outreach',
      prompt:
        'Build a list of 20 prospects matching our ideal customer profile and draft a first-touch email for each.',
    },
    {
      template: 'crm-hygiene',
      title: 'Clean up the CRM',
      prompt:
        'Find duplicate, stale, and incomplete records in our CRM and propose a cleanup I can approve.',
    },
  ],
  support: [
    {
      template: 'customer-support',
      title: 'Draft ticket replies',
      prompt: 'Read the open support tickets and draft a reply for each one, citing our docs.',
    },
    {
      template: 'escalation-manager',
      title: 'Catch escalations early',
      prompt: 'Scan open tickets for accounts at risk of escalating and summarize why.',
    },
    {
      template: 'inbox-triage',
      title: 'Triage the shared inbox',
      prompt: 'Sort the shared inbox into urgent, waiting-on-us, and no-action-needed.',
    },
  ],
  marketing: [
    {
      template: 'brand-monitor',
      title: 'Monitor brand mentions',
      prompt: 'Find where we were mentioned online this week and summarize the sentiment.',
    },
    {
      template: 'competitor-watch',
      title: 'Watch competitors',
      prompt: 'Check our top three competitors for pricing, product, and messaging changes.',
    },
    {
      template: 'content-refresh',
      title: 'Refresh stale content',
      prompt: 'Find published posts that are out of date and propose specific edits.',
    },
  ],
  engineering: [
    {
      template: 'error-triage',
      title: 'Triage new errors',
      prompt: 'Group this week’s new production errors by root cause and rank them by user impact.',
    },
    {
      template: 'oncall-triage',
      title: 'Summarize on-call',
      prompt:
        'Summarize the last on-call rotation: what paged, what was noise, and what needs a fix.',
    },
    {
      template: 'dependency-upgrades',
      title: 'Chase dependency upgrades',
      prompt:
        'List our outdated dependencies, flag the breaking ones, and propose an upgrade order.',
    },
  ],
  finance_ops: [
    {
      template: 'ap-invoice-processing',
      title: 'Process invoices',
      prompt:
        'Read the invoices received this month, extract the line items, and flag anything unusual.',
    },
    {
      template: 'expense-reconciliation',
      title: 'Reconcile expenses',
      prompt: 'Match this month’s card transactions against submitted receipts and list the gaps.',
    },
    {
      template: 'month-end-close',
      title: 'Prep month-end close',
      prompt: 'Build the month-end close checklist and tell me what is still outstanding.',
    },
  ],
  hr_recruiting: [
    {
      template: 'employee-onboarding',
      title: 'Onboard a new hire',
      prompt: 'Build a first-week onboarding plan for a new hire and draft their welcome email.',
    },
    {
      template: 'interview-scheduler',
      title: 'Schedule interviews',
      prompt:
        'Find times that work for the panel and draft the invites for this week’s candidates.',
    },
    {
      template: 'candidate-sourcing',
      title: 'Source candidates',
      prompt: 'Find candidates matching our open role and summarize why each one fits.',
    },
  ],
  other: [
    {
      template: 'meeting-notes',
      title: 'Turn notes into actions',
      prompt: 'Read my meeting notes and turn them into a list of owned action items.',
    },
    {
      template: 'inbox-triage',
      title: 'Triage my inbox',
      prompt: 'Sort my inbox into urgent, waiting-on-me, and no-action-needed.',
    },
    {
      template: 'competitor-watch',
      title: 'Watch the market',
      prompt: 'Check our top three competitors for pricing, product, and messaging changes.',
    },
  ],
};

/** `null` means the user skipped the survey — they still get useful prompts. */
export function starterPromptsFor(useCase: OnboardingUseCase | null): StarterPrompt[] {
  return STARTER_PROMPTS[useCase ?? 'other'];
}
