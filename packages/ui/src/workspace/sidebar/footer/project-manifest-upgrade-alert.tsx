'use client';

/**
 * ProjectManifestUpgradeAlert — the left-sidebar nudge that makes a project's
 * pre-v3 manifest (kortix_version 1 or 2) impossible to miss. Sits just above Files/Customize and
 * wears the shared footer alert shell (`sidebar-alert.tsx`) — the same one
 * `ProjectSandboxAlert` wears. It used to be a hand-copied duplicate of that
 * file's shell, which is how the two drifted to different paddings and
 * different open-state tints while their own comments claimed they matched.
 *
 * Tone is `info` rather than a failure colour: this is a recommended upgrade,
 * not something that is broken. A v2 project keeps running unchanged until
 * someone upgrades it. The action is one click, end to end: `useRunUpgrade`
 * mints a session seeded with `MIGRATE_TO_V3_PROMPT`, boots the project's
 * default agent (git/CR powers), and drops the user into the thread where it
 * auto-runs — `kortix migrate` to kortix.yaml version 3, then a change request
 * for review.
 *
 * Only renders while the project is on v1 or v2 AND the viewer can actually
 * act on it (`project.write` — the people who can push and open the CR); it
 * disappears for good the moment the manifest lands on v3.
 */

import { useTranslations } from '../../../i18n';
import { useState } from 'react';

import { Button } from '../../../primitives/button';
import Loading from '../../../primitives/loading';
import {
  MIGRATE_TO_V3_PROMPT,
  manifestNeedsUpgrade,
  useProjectManifestVersion,
  useRunUpgrade,
} from '../../../customize/migrate-to-v2';
import {
  SidebarAlert,
  SidebarAlertActions,
  SidebarAlertBody,
  SidebarAlertText,
} from './sidebar-alert';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectPageCans } from '../../../internal/lib/use-project-can';
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
  const t = useTranslations('sidebar');
  const [isOpen, setIsOpen] = useState(defaultOpen);
  if (!visible) return null;

  return (
    <SidebarAlert
      tone="info"
      icon={<ArrowUpCircle className="size-4" />}
      label={t('manifestUpgrade.title')}
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <SidebarAlertBody>
        <SidebarAlertText>
          {t.rich('manifestUpgrade.description', {
            yaml: (chunks) => <span className="font-mono">{chunks}</span>,
          })}
        </SidebarAlertText>
      </SidebarAlertBody>
      <SidebarAlertActions>
        <Button size="sm" className="w-full" disabled={pending} onClick={onMigrate}>
          {pending ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <ArrowUpCircle className="size-3.5 shrink-0" />
          )}
          {t('manifestUpgrade.start')}
        </Button>
      </SidebarAlertActions>
    </SidebarAlert>
  );
}

export function ProjectManifestUpgradeAlert({ projectId }: { projectId: string }) {
  const { version } = useProjectManifestVersion(projectId);
  const canWrite = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true;
  const run = useRunUpgrade(projectId);

  return (
    <ProjectManifestUpgradeAlertView
      visible={manifestNeedsUpgrade(version) && canWrite}
      pending={run.pending}
      onMigrate={() => run.start(MIGRATE_TO_V3_PROMPT)}
    />
  );
}
