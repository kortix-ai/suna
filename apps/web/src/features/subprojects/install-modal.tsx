'use client';

import {
  ArrowSquareOutIcon,
  DownloadSimpleIcon,
  FileZipIcon,
  GithubLogoIcon,
  StarIcon,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
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
  subprojectConnectorRows,
  subprojectIsUpload,
  subprojectRepoSlug,
  subprojectRepoUrl,
  formatCount,
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
  onInstall,
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
  /** Starts the install session. Resolves to its id, or null on failure. */
  onInstall: (subprojectId: string) => Promise<string | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [navigating, setNavigating] = useState(false);
  const { Icon, color, bgColor } = subprojectVisual(subproject.slug);
  const upload = subprojectIsUpload(subproject);
  const repoUrl = subprojectRepoUrl(subproject);
  const busy = installing || navigating;

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

  return (
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
          <SubprojectConnectors connectors={subprojectConnectorRows(subproject)} connected={connectedApps} />
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
          <span className="text-muted-foreground text-xs">
            {upload
              ? 'Installs into this project from the uploaded archive.'
              : 'Open source. Installs into this project from the linked repo.'}
          </span>
          {installed ? (
            // An installed subproject renders its state, not the action. Uninstall
            // lives on the installed list, next to what it would remove.
            <Button disabled>Installed</Button>
          ) : (
            <Button onClick={install} disabled={busy}>
              {busy ? <Loading className="size-4 shrink-0" /> : null}
              {busy ? 'Starting' : 'Install'}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
