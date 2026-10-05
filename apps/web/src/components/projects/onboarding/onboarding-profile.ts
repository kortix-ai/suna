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
