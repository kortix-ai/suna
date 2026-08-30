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
import { CraftConnectors } from './craft-connectors';
import { craftVisual } from './craft-visual';
import {
  craftConnectorRows,
  craftIsUpload,
  craftRepoSlug,
  craftRepoUrl,
  formatCount,
  type Craft,
} from './crafts-catalog';

/**
 * The install modal — the trust surface for one craft: what it is, WHICH
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
export function CraftInstallModal({
  craft,
  projectId,
  installed = false,
  connectedApps,
  installing = false,
  onInstall,
  open,
  onOpenChange,
}: {
  craft: Craft;
  projectId: string;
  /** Whether this project already has it — from `useProjectCrafts`. */
  installed?: boolean;
  /** Apps the project already has connected. Undefined while unknown. */
  connectedApps?: ReadonlySet<string>;
  installing?: boolean;
  /** Starts the install session. Resolves to its id, or null on failure. */
  onInstall: (craftId: string) => Promise<string | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [navigating, setNavigating] = useState(false);
  const { Icon, color, bgColor } = craftVisual(craft.slug);
  const upload = craftIsUpload(craft);
  const repoUrl = craftRepoUrl(craft);
  const busy = installing || navigating;

  const install = async () => {
    setNavigating(true);
    try {
      const sessionId = await onInstall(craft.craft_id);
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
      <ModalContent className="lg:max-w-md" aria-label={`Install ${craft.title}`}>
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
              <ModalTitle>{craft.title}</ModalTitle>
              <ModalDescription className="truncate font-mono">
                {craftRepoSlug(craft)}
                {craft.git_ref ? `@${craft.git_ref}` : ''}
              </ModalDescription>
            </div>
          </div>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
            {craft.description ?? 'This craft ships no description in its kortix.yaml.'}
          </p>
          <CraftConnectors connectors={craftConnectorRows(craft)} connected={connectedApps} />
          {/* The source row. A github craft links out so provenance is one click
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
              <span className="min-w-0 truncate font-mono">{craftRepoSlug(craft)}</span>
              {craft.stars === null ? null : (
                <>
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
                    <StarIcon weight="fill" className="size-3" aria-hidden />
                    {formatCount(craft.stars)}
                  </span>
                  <span aria-hidden className="text-muted-foreground/40 shrink-0">
                    &bull;
                  </span>
                </>
              )}
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 tabular-nums',
                  craft.stars === null && 'ml-auto',
                )}
              >
                <DownloadSimpleIcon className="size-3" aria-hidden />
                {formatCount(craft.install_count)}
              </span>
              <ArrowSquareOutIcon className="size-3 shrink-0 opacity-60" aria-hidden />
            </a>
          ) : (
            <div className="bg-popover text-muted-foreground flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs">
              <FileZipIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 truncate font-mono">
                {craft.upload_name ?? craft.slug}
              </span>
              <span className="ml-auto shrink-0 tabular-nums">
                {craft.file_count} file{craft.file_count === 1 ? '' : 's'}
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
            // An installed craft renders its state, not the action. Uninstall
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
