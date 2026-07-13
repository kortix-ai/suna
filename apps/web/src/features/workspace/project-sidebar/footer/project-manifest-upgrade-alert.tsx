'use client';

/**
 * ProjectManifestUpgradeAlert — the left-sidebar nudge that makes a project's
 * still-on-v1 manifest impossible to miss. Sits just above Files/Customize and
 * mirrors `ProjectSandboxAlert` exactly (same `Disclosure` shell, same expand
 * -to-explain-then-act shape) — the only differences are the tone (kortix
 * accent, since this is a recommended upgrade rather than a failure) and the
 * action, which is the one-click, end-to-end `useMigrateToV2`: it mints a
 * session seeded with the migration prompt, boots the project's default agent
 * (git/CR powers), and drops the user into the thread where it auto-runs —
 * converting kortix.toml → kortix.yaml and opening a change request for review.
 *
 * Only renders while the project is on v1 AND the viewer can actually act on it
 * (`project.write` — the people who can push and open the CR); it disappears
 * for good the moment the manifest lands on v2.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Loading from '@/components/ui/loading';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import {
  useMigrateToV2,
  useProjectManifestVersion,
} from '@/features/workspace/customize/migrate-to-v2';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { ArrowUpCircle } from 'lucide-react';

/** Presentational shell — no data fetching, so every state renders under
 *  renderToStaticMarkup. The network/permission reads live in the wrapper. */
export function ProjectManifestUpgradeAlertView({
  visible,
  pending,
  onMigrate,
  defaultOpen = false,
}: {
  visible: boolean;
  pending: boolean;
  onMigrate: () => void;
  /** Seed the disclosure open — only used so the expanded body is renderable
   *  in tests; the real sidebar always starts collapsed. */
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  if (!visible) return null;

  return (
    <SidebarMenuItem>
      <Disclosure
        variant="outline"
        open={isOpen}
        onOpenChange={setIsOpen}
        className={cn(
          'w-full overflow-hidden rounded-md border-none text-sm shadow-none',
          isOpen && 'bg-kortix-base/[0.06]',
        )}
      >
        <DisclosureTrigger>
          <SidebarMenuButton className="text-kortix-base px-2.5 text-sm! font-medium [&_svg]:size-3.5!">
            <ArrowUpCircle className="size-4" />
            <span>Upgrade to v2</span>
          </SidebarMenuButton>
        </DisclosureTrigger>
        <DisclosureContent variant="outline">
          <div className="w-full overflow-hidden">
            <div className="px-2 pt-1 pb-3">
              <p className="text-muted-foreground text-xs text-balance">
                This project still runs the v1 <span className="font-mono">kortix.toml</span>.
                Migrate to the governance-first <span className="font-mono">kortix.yaml</span> — an
                agent converts it, refreshes platform-managed skills, and opens a change request for
                you to review.
              </p>
            </div>
            <div className="border-border flex flex-col gap-2 border-t p-3">
              <Button size="sm" className="w-full" disabled={pending} onClick={onMigrate}>
                {pending ? (
                  <Loading className="text-foreground! size-3.5" />
                ) : (
                  <ArrowUpCircle className="size-3.5" />
                )}
                Migrate to v2
              </Button>
            </div>
          </div>
        </DisclosureContent>
      </Disclosure>
    </SidebarMenuItem>
  );
}

export function ProjectManifestUpgradeAlert({ projectId }: { projectId: string }) {
  const { version } = useProjectManifestVersion(projectId);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  const migrate = useMigrateToV2(projectId);

  return (
    <ProjectManifestUpgradeAlertView
      visible={version === 1 && canWrite}
      pending={migrate.pending}
      onMigrate={migrate.start}
    />
  );
}
