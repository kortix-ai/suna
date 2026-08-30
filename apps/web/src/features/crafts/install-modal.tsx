'use client';

import { DownloadSimpleIcon, GithubLogoIcon, StarIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { craftRepoSlug, craftRepoUrl, formatCount, type Craft } from './crafts-catalog';

/**
 * The install modal — minimal trust surface for the GitHub craft: what it is,
 * where its source lives (linked out to the repo), how proven it is. UI PHASE:
 * `Install` is client-side only — it closes the modal and toasts. No API call
 * exists behind it yet.
 */
export function CraftInstallModal({
  craft,
  open,
  onOpenChange,
}: {
  craft: Craft;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const Icon = craft.icon;

  const install = () => {
    onOpenChange(false);
    // UI phase: no install API behind this click. The toast states what the
    // real flow will do, so the interaction reads complete without faking one.
    successToast(`${craft.title} installed — it starts in the next session`);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md" aria-label={`Install ${craft.title}`}>
        <ModalHeader>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'bg-background border-border shadow-2xs flex size-10 shrink-0 items-center justify-center rounded-md border',
                craft.bgColor,
                craft.color,
              )}
            >
              <Icon weight="fill" className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <ModalTitle>{craft.title}</ModalTitle>
              <ModalDescription className="truncate font-mono">{craftRepoSlug(craft)}</ModalDescription>
            </div>
          </div>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
            {craft.description}
          </p>
          {/* The source row — links out to GitHub so the craft's provenance is
              one click away. Meta numbers stay tabular so they never shift. */}
          <a
            href={craftRepoUrl(craft)}
            target="_blank"
            rel="noreferrer"
            className="hover:border-foreground/20 bg-popover text-muted-foreground hover:text-foreground flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs transition-colors duration-150"
          >
            <GithubLogoIcon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate font-mono">{craftRepoSlug(craft)}</span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
              <StarIcon weight="fill" className="size-3" aria-hidden />
              {formatCount(craft.repo.stars)}
            </span>
            <span aria-hidden className="text-muted-foreground/40 shrink-0">
              &bull;
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <DownloadSimpleIcon className="size-3" aria-hidden />
              {formatCount(craft.installs)}
            </span>
          </a>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <span className="text-muted-foreground text-xs">
            Open source. Installs into this project from the linked repo.
          </span>
          {/* UI phase: an installed craft renders the state, not an action —
              management (pause/remove) arrives with the real install flow. */}
          {craft.installed ? <Button disabled>Installed</Button> : <Button onClick={install}>Install</Button>}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
