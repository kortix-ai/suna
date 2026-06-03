'use client';

import {
  useAccountState,
  accountStateSelectors,
} from '@/hooks/billing/use-account-state';
import { SHOW_PERSONAL_CONTACT } from '@/lib/kortix-flags';

/**
 * Which help/contact surface a viewer gets:
 *  - `'none'`     — self-hosters (cloud flag off): show nothing.
 *  - `'standard'` — cloud, NOT on a paid plan: a generic "talk to our team"
 *                   widget (book a demo via /contact). No personal channels.
 *  - `'personal'` — cloud, on a PAID plan: the full founder concierge —
 *                   "Hey, I'm Marko", book a call, WhatsApp, direct email.
 *
 * Concierge access (the personal tier) is a perk for paying customers; everyone
 * else on cloud still gets a way to reach the team.
 */
export type PersonalContactTier = 'none' | 'standard' | 'personal';

/**
 * Resolve the contact tier from the cloud build flag + the viewer's plan.
 * Returns `'standard'` (not `'personal'`) until account state has loaded, so a
 * paid user briefly sees the team widget rather than nothing while billing
 * fetches — and we never flash the founder card to a free user. Skips the
 * billing query entirely when the build flag is off.
 */
export function usePersonalContactTier(): PersonalContactTier {
  // Only hit the billing endpoint when the build flag is on — self-hosters
  // (flag off) should never trigger an account-state fetch for this.
  const { data: accountState } = useAccountState({
    enabled: SHOW_PERSONAL_CONTACT,
  });

  if (!SHOW_PERSONAL_CONTACT) return 'none';

  const tierKey = accountStateSelectors.tierKey(accountState)?.toLowerCase();
  const isPaid = !!tierKey && tierKey !== 'none' && tierKey !== 'free';
  return isPaid ? 'personal' : 'standard';
}

/**
 * Whether the *personal* founder surfaces should show (paid + cloud only).
 * Used by surfaces that have no standard fallback (e.g. the onboarding wizard's
 * "Book a call with Marko" step). Equivalent to `tier === 'personal'`.
 */
export function useShowPersonalContact(): boolean {
  return usePersonalContactTier() === 'personal';
}
