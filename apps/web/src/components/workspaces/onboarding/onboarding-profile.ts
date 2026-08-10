/**
 * Pure onboarding logic — no React, no network, no DOM.
 *
 * Everything the wizard decides that does not need to render lives here so it
 * can be asserted directly instead of through a mounted component. Keeping it
 * dependency-free is what makes the seven-step flow cheap to test.
 */

import { emailDomain, isWorkEmail } from '@/lib/personal-email';
import type { OnboardingCompanySize, OnboardingUseCase } from '@kortix/sdk';
import type { IconWeight } from '@phosphor-icons/react';

export type StepId = 'use-case' | 'company' | 'tools' | 'slack' | 'plan' | 'done';

export interface UseCaseOption {
  value: OnboardingUseCase;
  label: string;
  description: string;
  weight: IconWeight;
}

/**
 * Ordered by how often the matching department appears across
 * `apps/web/content/use-cases/` — Sales (11 posts), Engineering (9), Finance
 * (7), Support/CS (7), Ops (5), Marketing (5), HR/Recruiting (4).
 */
export const USE_CASE_OPTIONS: readonly UseCaseOption[] = [
  { value: 'sales', label: 'Sales', description: 'Follow up on leads, keep the CRM clean',weight: 'regular' },
  { value: 'support', label: 'Customer support', description: 'Triage tickets, draft replies',weight: 'duotone' },
  { value: 'marketing', label: 'Marketing', description: 'Watch the market, refresh content',weight: 'duotone' },
  { value: 'engineering', label: 'Engineering', description: 'Triage errors, chase upgrades',weight: 'regular' },
  {
    value: 'finance_ops',
    label: 'Finance & operations',
    description: 'Invoices, expenses, month-end close',
    weight: 'regular',
  },
  {
    value: 'hr_recruiting',
    label: 'HR & recruiting',
    description: 'Onboarding, scheduling, sourcing',
      weight: 'duotone',
  },
  { value: 'other', label: 'Something else', description: 'We’ll start you with the basics',weight: 'regular' },
] as const;

/**
 * Mirrors `features/contact/demo-qualifier-modal.tsx`.
 *
 * That modal hides `1-10` for personal-email signups. Onboarding deliberately
 * does NOT replicate the filter: it is a lead-qualification rule, not a data
 * model rule, and hiding a truthful option here would corrupt the answer.
 */
export const COMPANY_SIZES: readonly OnboardingCompanySize[] = [
  '1-10',
  '11-50',
  '51-200',
  '201-1000',
  '1000+',
] as const;

/**
 * No welcome step. A screen that asks nothing and tells nothing is a screen
 * the user pays for and gets nothing back from — Alan, Brilliant, and Headspace
 * all open directly on their first real question. The founder-concierge CTA
 * that used to live on the welcome screen moves to the finish step.
 */
const ALL_STEPS: readonly StepId[] = ['use-case', 'company', 'tools', 'slack', 'plan', 'done'];

/**
 * Self-host without Pipedream configured (`isConnectorsEnabled()` false) has no
 * catalogue to offer, so the tools step is dropped rather than landing the user
 * on a dead 501.
 */
export function buildSteps(connectorsEnabled: boolean): StepId[] {
  return ALL_STEPS.filter((id) => connectorsEnabled || id !== 'tools');
}

const SURVEY_STEPS: readonly StepId[] = ['use-case', 'company'];

/**
 * The eyebrow counts SURVEY questions, not wizard steps — so dropping the tools
 * step never renumbers it.
 */
export function surveyPosition(stepId: StepId): { index: number; total: number } | null {
  const i = SURVEY_STEPS.indexOf(stepId);
  return i === -1 ? null : { index: i + 1, total: SURVEY_STEPS.length };
}

/**
 * Where "Skip" lands from a survey question: the first step that is not itself
 * a survey question.
 *
 * Computed from the step list rather than hardcoded, because the tools step is
 * absent when connectors are disabled — a fixed index would drop the user onto
 * the wrong screen on a self-host build.
 */
export function firstStepAfterSurvey(steps: readonly StepId[]): number {
  const i = steps.findIndex((s) => !surveyPosition(s));
  return i === -1 ? Math.max(steps.length - 1, 0) : i;
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

/**
 * Company domain field: empty is allowed (optional survey), otherwise require a
 * hostname or http(s) URL the agent can research — `acme.com` or
 * `https://acme.com`. Rejects other schemes, single-label hosts, and free text.
 */
export function isValidCompanyHttpLink(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return false;
  // Bare IPs are not company domains; a real site host has at least one label.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;

  return true;
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
      prompt:
        'Group this week’s new production errors by root cause and rank them by user impact.',
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
      prompt: 'Find times that work for the panel and draft the invites for this week’s candidates.',
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
