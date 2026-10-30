import { redirect } from 'next/navigation';

import { PROJECT_LANDING_PATH } from '@kortix/ui/internal/lib/onboarding/landing-destination';

/**
 * /setup redirects into the repo-first project shell. Setup now happens from
 * account and project settings rather than the legacy dashboard workspace.
 */
export default function SetupPage() {
  redirect(PROJECT_LANDING_PATH);
}
