import { redirect } from 'next/navigation';

import { WORKSPACE_LANDING_PATH } from '@/lib/onboarding/landing-destination';

/**
 * The workspaces list is gone. `landing-destination.ts` has said for a while that
 * "the product is a workspace, not a list of projects", and the switcher menu is
 * now the complete workspace directory — so the list had no job left.
 *
 * This redirects rather than 404s because `/projects` is bookmarkable and was
 * linked from the user menu. The landing door resolves whichever workspace the
 * user actually wants, which is what someone typing `/projects` meant anyway.
 */
export default function WorkspacesIndexPage() {
  redirect(WORKSPACE_LANDING_PATH);
}
