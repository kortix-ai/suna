'use client';

import { ArrowSquareOutIcon, GithubLogoIcon } from '@phosphor-icons/react';
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
import { TemplateConnectors } from './template-connectors';
import { templateVisual } from './template-visual';
import {
  type MarketplaceTemplate,
  templateConnectorRows,
  templateRepoSlug,
  templateRepoUrl,
} from './templates-catalog';

/**
 * The install modal — the trust surface for one template: what it is, WHICH
 * THIRD-PARTY APPS IT TOUCHES, and where its source lives.
 *
 * `Install` starts a real agent-driven session and navigates to it. It does NOT
 * install anything by itself: the session's agent reads both manifests, merges,
 * and opens a change request the user reviews. The footer says so IN the modal,
 * beside the button — a modal that closed with "Installed" would claim a merge
 * nobody approved.
 *
 * The connector list sits above the source row because it answers the question
 * that gates the install ("what does this reach into?"); the repo row answers
 * provenance.
 */
export function TemplateInstallModal({
  template,
  projectId,
  connectedApps,
  installing = false,
  onInstall,
  open,
  onOpenChange,
}: {
  template: MarketplaceTemplate;
  projectId: string;
  /** Apps the project already has connected. Undefined while unknown. */
  connectedApps?: ReadonlySet<string>;
  installing?: boolean;
  /** Starts the install session. Resolves to its id, or null on failure. */
  onInstall: (slug: string) => Promise<string | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [navigating, setNavigating] = useState(false);
  const { Icon, color, bgColor } = templateVisual(template.slug);
  const connectors = templateConnectorRows(template);
  const busy = installing || navigating;

  const install = async () => {
    setNavigating(true);
    try {
      const sessionId = await onInstall(template.slug);
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
      <ModalContent className="lg:max-w-md" aria-label={`Install ${template.title}`}>
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
              <ModalTitle>{template.title}</ModalTitle>
              <ModalDescription className="truncate font-mono">
                {templateRepoSlug(template)}
                {template.git_ref ? `@${template.git_ref}` : ''}
              </ModalDescription>
            </div>
          </div>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
            {template.description ?? 'This template ships no description in its kortix.yaml.'}
          </p>
          <TemplateConnectors connectors={connectors} connected={connectedApps} />
          {/* The source row links out so provenance is one click away. */}
          <a
            href={templateRepoUrl(template)}
            target="_blank"
            rel="noreferrer"
            className="hover:border-foreground/20 bg-popover text-muted-foreground hover:text-foreground duration-normal flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs transition-colors"
          >
            <GithubLogoIcon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate font-mono">{templateRepoSlug(template)}</span>
            <ArrowSquareOutIcon className="ml-auto size-3 shrink-0 opacity-60" aria-hidden />
          </a>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <span className="text-muted-foreground text-xs">
            Open source. Install opens a change request you review.
          </span>
          <Button onClick={install} disabled={busy}>
            {busy ? <Loading className="size-4 shrink-0" /> : null}
            {busy ? 'Starting' : 'Install'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
