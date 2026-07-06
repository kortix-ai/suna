'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { SHOW_PERSONAL_CONTACT } from '@/lib/kortix-flags';
import { isWorkEmail } from '@/lib/personal-email';

/**
 * Which help/contact surface a viewer gets:
 *  - `'none'`     — self-hosters (cloud flag off): show nothing.
 *  - `'standard'` — cloud, signed up with a personal/consumer email: a
 *                   generic "talk to our team" widget (book a demo via
 *                   /contact). No personal channels.
 *  - `'personal'` — cloud, signed up with a work email: the full founder
 *                   concierge — "Hey, I'm Marko", book a call, WhatsApp,
 *                   direct email.
 *
 * Gated on work email, not plan: we want to sell a prospect on the concierge
 * treatment before they pay, not after. Anyone can sign up with a personal
 * inbox, so that's the one thing worth gating on to keep this from being a
 * spam vector for Marko's direct contact info.
 */
export type PersonalContactTier = 'none' | 'standard' | 'personal';

/** Resolve the contact tier from the cloud build flag + the signup email domain. */
export function usePersonalContactTier(): PersonalContactTier {
  const { user } = useAuth();

  if (!SHOW_PERSONAL_CONTACT) return 'none';

  return isWorkEmail(user?.email) ? 'personal' : 'standard';
}

/**
 * Whether the *personal* founder surfaces should show (paid + cloud only).
 * Used by surfaces that have no standard fallback (e.g. the onboarding wizard's
 * "Book a call with Marko" step). Equivalent to `tier === 'personal'`.
 */
export function useShowPersonalContact(): boolean {
  return usePersonalContactTier() === 'personal';
}
