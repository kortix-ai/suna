'use client';

import {
  ArrowSquareOutIcon,
  DownloadSimpleIcon,
  FileZipIcon,
  GithubLogoIcon,
  StarIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { prepareInstallSessionNavigation } from '../session/install-session-navigation';
import { SubprojectConnectors } from './subproject-connectors';
import { subprojectVisual } from './subproject-visual';
import {
  countLabel,
  formatCount,
  subprojectConnectorRows,
  subprojectIsUpload,
  subprojectRepoSlug,
  subprojectRepoUrl,
  type Subproject,
} from './subprojects-catalog';

/**
 * The install modal — the trust surface for one subproject: what it is, WHICH
 * THIRD-PARTY APPS IT TOUCHES, where its source lives, how proven it is.
 *
 * `Install` starts a real agent-driven session and navigates to it. It does NOT
 * install anything by itself: the session's agent reads both manifests, merges,
 * and opens a change request the user reviews. That is why the button says what
 * happens next and the footer states the install lands as a change request —
 * a modal that closed with "Installed" would claim a merge nobody approved.
 *
 * It owns UNINSTALL too, for the same reason it owns install: this is the one
 * place that shows what a subproject brings into the project, so it is the one
 * place a person can judge what removing it takes away. That used to live on an
 * "Installed · N" list on the store page; the list is gone, and a marketplace
 * with no uninstall would be a one-way door.
 *
 * The connector list sits above the source row because it answers the question
 * that gates the install ("what does this reach into?"); the repo row answers
 * provenance.
 */
export function SubprojectInstallModal({
  subproject,
  projectId,
  installed = false,
  connectedApps,
  installing = false,
  uninstalling = false,
  onInstall,
  onUninstall,
  open,
  onOpenChange,
}: {
  subproject: Subproject;
  projectId: string;
  /** Whether this project already has it — from `useProjectSubprojects`. */
  installed?: boolean;
  /** Apps the project already has connected. Undefined while unknown. */
  connectedApps?: ReadonlySet<string>;
  installing?: boolean;
  uninstalling?: boolean;
  /** Starts the install session. Resolves to its id, or null on failure. */
  onInstall: (subprojectId: string) => Promise<string | null>;
  /** Starts the uninstall session by slug. Resolves to its id, or null. */
  onUninstall?: (slug: string) => Promise<string | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [navigating, setNavigating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { Icon, color, bgColor } = subprojectVisual(subproject.slug);
  const upload = subprojectIsUpload(subproject);
  const repoUrl = subprojectRepoUrl(subproject);
  const connectors = subprojectConnectorRows(subproject);
  const busy = installing || navigating;
  const removing = uninstalling || navigating;

  const install = async () => {
    setNavigating(true);
    try {
      const sessionId = await onInstall(subproject.subproject_id);
      if (!sessionId) return;
      // Warm the route and the session's start payload before navigating, so
      // the install session opens on a seeded page rather than a spinner.
      const href = prepareInstallSessionNavigation(queryClient, router, projectId, sessionId);
      onOpenChange(false);
      if (href) router.push(href);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Could not start the install session');
    } finally {
      setNavigating(false);
    }
  };

  const uninstall = async () => {
    if (!onUninstall) return;
    setNavigating(true);
    try {
      const sessionId = await onUninstall(subproject.slug);
      if (!sessionId) return;
      setConfirming(false);
      // Uninstall is a SESSION, like install — the agent removes the entries and
      // opens a change request. Navigating there is the only honest ending: the
      // subproject is still installed until that CR merges.
      const href = prepareInstallSessionNavigation(queryClient, router, projectId, sessionId);
      onOpenChange(false);
      if (href) router.push(href);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Could not start the uninstall session');
    } finally {
      setNavigating(false);
    }
  };

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-md" aria-label={`Install ${subproject.title}`}>
          <ModalHeader>
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  'border-border flex size-10 shrink-0 items-center justify-center rounded-md border shadow-2xs',
                  bgColor,
                  color,
                )}
              >
                <Icon weight="fill" className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <ModalTitle>{subproject.title}</ModalTitle>
                <ModalDescription className="truncate font-mono">
                  {subprojectRepoSlug(subproject)}
                  {subproject.git_ref ? `@${subproject.git_ref}` : ''}
                </ModalDescription>
              </div>
            </div>
          </ModalHeader>
          <ModalBody className="space-y-4">
            <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
              {subproject.description ?? 'This subproject ships no description in its kortix.yaml.'}
            </p>
            <SubprojectConnectors connectors={connectors} connected={connectedApps} />
            {/* The source row. A github subproject links out so provenance is one click
              away; an upload has no repository, so the row states what it is
              instead of linking to a 404. Meta numbers stay tabular. */}
            {repoUrl ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:border-foreground/20 bg-popover text-muted-foreground hover:text-foreground flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs transition-colors duration-150"
              >
                <GithubLogoIcon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 truncate font-mono">{subprojectRepoSlug(subproject)}</span>
                {subproject.stars === null ? null : (
                  <>
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
                      <StarIcon weight="fill" className="size-3" aria-hidden />
                      {formatCount(subproject.stars)}
                    </span>
                    <span aria-hidden className="text-muted-foreground/40 shrink-0">
                      &bull;
                    </span>
                  </>
                )}
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 tabular-nums',
                    subproject.stars === null && 'ml-auto',
                  )}
                >
                  <DownloadSimpleIcon className="size-3" aria-hidden />
                  {formatCount(subproject.install_count)}
                </span>
                <ArrowSquareOutIcon className="size-3 shrink-0 opacity-60" aria-hidden />
              </a>
            ) : (
              <div className="bg-popover text-muted-foreground flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs">
                <FileZipIcon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 truncate font-mono">
                  {subproject.upload_name ?? subproject.slug}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {countLabel(subproject.file_count, 'file')}
                </span>
              </div>
            )}
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            {/* The left sentence is the only place the modal states install state
              now that the button is an action in both directions. Saying
              "Installed in this project" beside an `Uninstall` button is what
              keeps the button from reading as "uninstall it from the store". */}
            <span className="text-muted-foreground text-xs">
              {installed
                ? 'Installed in this project.'
                : upload
                  ? 'Installs into this project from the uploaded archive.'
                  : 'Open source. Installs into this project from the linked repo.'}
            </span>
            {installed ? (
              // `outline`, not `destructive`: the weight belongs on the confirm
              // step, where the consequence is spelled out. A red button in a
              // browse-and-install modal shouts at every person who opened it to
              // read the description.
              <Button variant="outline" onClick={() => setConfirming(true)} disabled={removing}>
                {removing ? <Loading className="size-4 shrink-0" /> : null}
                {removing ? 'Starting' : 'Uninstall'}
              </Button>
            ) : (
              <Button onClick={install} disabled={busy}>
                {busy ? <Loading className="size-4 shrink-0" /> : null}
                {busy ? 'Starting' : 'Install'}
              </Button>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>
      {/* A sibling of the modal, not a child: two nested Radix modal layers
          fight over the focus trap. `access-dialog.tsx` places its own
          ConfirmDialog the same way. */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Uninstall ${subproject.title}?`}
        description={
          <span className="space-y-2">
            <span className="block">
              This starts a session where the agent removes what this subproject contributed and
              opens a change request. Nothing is removed until you merge it.
            </span>
            {connectors.length > 0 ? (
              // Stated because it is the one thing uninstall does NOT do. A
              // person who reads "removed" and assumes the OAuth grant went
              // with it has been misled by omission.
              <span className="block">
                Its connectors may hold credentials. The agent removes the manifest entries only —
                it never revokes a connection.
              </span>
            ) : null}
          </span>
        }
        confirmLabel="Start uninstall"
        confirmVariant="destructive"
        confirmIcon={<TrashIcon className="size-4" aria-hidden />}
        isPending={removing}
        onConfirm={() => void uninstall()}
      />
    </>
  );
}
