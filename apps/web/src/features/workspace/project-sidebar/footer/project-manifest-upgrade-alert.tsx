'use client';

/**
 * ProjectManifestUpgradeAlert — the left-sidebar nudge that makes a project's
 * still-on-v1 manifest impossible to miss. Sits just above Files/Customize and
 * wears the shared footer alert shell (`sidebar-alert.tsx`) — the same one
 * `ProjectSandboxAlert` wears. It used to be a hand-copied duplicate of that
 * file's shell, which is how the two drifted to different paddings and
 * different open-state tints while their own comments claimed they matched.
 *
 * Tone is `info` rather than a failure colour: this is a recommended upgrade,
 * not something that is broken. The action is the one-click, end-to-end
 * `useMigrateToV2`: it mints a session seeded with the migration prompt, boots
 * the project's default agent (git/CR powers), and drops the user into the
 * thread where it auto-runs — converting kortix.toml → kortix.yaml and opening
 * a change request for review.
 *
 * Only renders while the project is on v1 AND the viewer can actually act on it
 * (`project.write` — the people who can push and open the CR); it disappears
 * for good the moment the manifest lands on v2.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  useMigrateToV2,
  useProjectManifestVersion,
} from '@/features/workspace/customize/migrate-to-v2';
import {
  SidebarAlert,
  SidebarAlertActions,
  SidebarAlertBody,
  SidebarAlertText,
} from '@/features/workspace/project-sidebar/footer/sidebar-alert';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';
import { ArrowCircleUpIcon as ArrowUpCircle } from '@phosphor-icons/react';

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
    <SidebarAlert
      tone="info"
      icon={<ArrowUpCircle className="size-4" />}
      label="Upgrade to v2"
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <SidebarAlertBody>
        <SidebarAlertText>
          This project still runs <span className="font-mono">kortix.toml</span>. An agent converts
          it to <span className="font-mono">kortix.yaml</span>, refreshes managed skills, and opens
          a change request. Nothing changes until you approve it.
        </SidebarAlertText>
      </SidebarAlertBody>
      <SidebarAlertActions>
        <Button size="sm" className="w-full" disabled={pending} onClick={onMigrate}>
          {pending ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <ArrowUpCircle className="size-3.5 shrink-0" />
          )}
          Start upgrade
        </Button>
      </SidebarAlertActions>
    </SidebarAlert>
  );
}

export function ProjectManifestUpgradeAlert({ projectId }: { projectId: string }) {
  const { version } = useProjectManifestVersion(projectId);
  const canWrite = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true;
  const migrate = useMigrateToV2(projectId);

  return (
    <ProjectManifestUpgradeAlertView
      visible={version === 1 && canWrite}
      pending={migrate.pending}
      onMigrate={migrate.start}
    />
  );
}
