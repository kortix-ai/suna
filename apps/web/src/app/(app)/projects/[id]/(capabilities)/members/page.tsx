'use client';

/**
 * /projects/[id]/members — legacy entry into the standalone Members page,
 * which no longer exists: Members moved off the project and onto the
 * account's Access rail (`/accounts/[id]?tab=access-projects`), scoped back
 * down to this project via `&project=<id>` so the account page opens
 * pre-filtered to it. This route is kept ONLY so bookmarks, sidebar links,
 * and `capabilityTabHref(projectId, 'members')` callers still land somewhere
 * real: it resolves the account id and replaces straight there.
 *
 * `useLegacySectionRedirect`, not a synchronous `redirect()`: the
 * destination needs `project.account_id`, a field on the project detail —
 * i.e. a network read — the same reason `customize/[section]/page.tsx` needs
 * it for every other account-scoped legacy section (see that file). The hook
 * folds `members` into `ACCOUNT_GRADUATED` (`settings-tabs.ts`) and appends
 * the `&project=` scoping itself, so this route only has to wait for
 * `pending` and replace to whatever `href` it produces.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { useLegacySectionRedirect } from '@/features/workspace/settings/use-account-section-redirect';

export default function ProjectMembersRedirect() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const router = useRouter();

  const legacy = useLegacySectionRedirect(projectId, 'members');

  useEffect(() => {
    if (!projectId) return;
    // Hold rather than fall back: `pending` means the account id is still
    // resolving, and replacing now would drop the `&project=` scoping and
    // land on the bare settings overlay instead of the account page.
    if (legacy.pending) return;
    router.replace(legacy.href ?? `/projects/${projectId}/settings`);
  }, [projectId, legacy.href, legacy.pending, router]);

  return null;
}
