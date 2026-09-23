'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useRouter } from 'next/navigation';

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
import { rememberGitHubSetupReturn } from '@/lib/github-installations';
import { GithubLogoIcon as Github } from '@phosphor-icons/react';

/**
 * "Add a GitHub account" — the ONE dialog for linking a GitHub personal
 * account or organization to a Kortix account. The account Git tab and `/new`
 * both open it, so the two surfaces can never drift into two different
 * stories about how a connection is made.
 *
 * Two labelled actions, not one ambiguous button. Which one a user needs
 * depends on a fact only they know — whether the Kortix App is already
 * installed on the GitHub account they have in mind — so the dialog states
 * both and lets them pick. Installing is the primary action: it works no
 * matter what the user's GitHub looks like. Linking an existing installation
 * only helps when the App is already on the owner they have in mind — and it
 * used to be the ONLY thing the hub's button did, with no label saying so.
 *
 * Both actions are real navigations away from the app (github.com, or the
 * `/github/setup` proof page). `returnPath` is remembered first so the setup
 * page can bring the user back to exactly where they left
 * (`consumeGitHubSetupReturn`).
 */
export function AddGitHubAccountDialog({
  open,
  onOpenChange,
  accountId,
  installUrl,
  returnPath,
  onBeforeLeave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  /** Where GitHub installs the Kortix App — `install_url` off
   *  `listGitHubInstallations`. Null on an instance with no App configured;
   *  the action then says so instead of opening a 404 on github.com. */
  installUrl: string | null;
  /** The in-app path to return to after the link completes. */
  returnPath: string;
  /** Surface-specific bookkeeping before the navigation (the hub drops the
   *  history entry its modal pushed). */
  onBeforeLeave?: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();

  function leave() {
    rememberGitHubSetupReturn(returnPath);
    onBeforeLeave?.();
    onOpenChange(false);
  }

  /** A real page load on github.com. GitHub redirects back to `/github/setup`
   *  with `state` and `installation_id`, which is where the link is written. */
  function handleInstallOnGitHub() {
    if (!installUrl) return;
    leave();
    window.location.assign(installUrl);
  }

  /** No GitHub install, just the identity proof plus a pick from the
   *  installations this GitHub user already administers. */
  function handleLinkExisting() {
    leave();
    router.replace(`/github/setup?account_id=${encodeURIComponent(accountId)}`);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('textf7be8a17b0e7')}</ModalTitle>
          <ModalDescription>{tI18nComplete.raw('text659d5668b62b')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            {tI18nComplete.raw('textdc520b664af2')}
          </p>
          <Button
            type="button"
            size="lg"
            className="w-full gap-1.5"
            disabled={!installUrl}
            onClick={handleInstallOnGitHub}
          >
            <Github className="size-4" />
            {tI18nComplete.raw('text8d3f36f31348')}
          </Button>
          {installUrl ? null : (
            <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
              {tI18nComplete.raw('text183bc0d276cc')}
            </p>
          )}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-muted-foreground text-xs">
              {tI18nComplete.raw('text7f59f014cd7b')}
            </span>
            <Button
              type="button"
              variant="transparent"
              size="sm"
              className="h-auto p-0"
              onClick={handleLinkExisting}
            >
              {tI18nComplete.raw('text9180f7df8906')}
            </Button>
          </div>
        </ModalBody>
        <ModalFooter className="pb-5">
          <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
