'use client';

/**
 * Every public link this session is currently handing out, and the only way to
 * take one back.
 *
 * The API has had list and revoke since the share table shipped; no surface
 * ever called them, so a link, once minted, was permanent and invisible. That
 * is the part of "share" that was actually missing — minting was only ever half
 * a feature.
 *
 * Revoked and expired links are shown separately rather than hidden: "I already
 * turned that off" is exactly the question this panel exists to answer, and an
 * empty list cannot distinguish "never shared" from "revoked it yesterday".
 */

import type { SessionPublicShare } from '@kortix/sdk';
import {
  CheckIcon as Check,
  FileTextIcon as FileText,
  GlobeIcon as Globe,
  LinkSimpleIcon as Link2,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  isShareLive,
  shareListState,
  useRevokePublicShare,
  useSessionPublicShares,
} from '@/hooks/use-session-public-shares';
import { cn } from '@/lib/utils';

/**
 * Read at render time, not in an event handler, so it must survive SSR. Today
 * it never runs on the server (the list is empty until react-query resolves, so
 * only the empty state renders), but that is a property of the fetch timing
 * rather than of this function — guard it rather than depend on that holding.
 */
function shareUrl(share: SessionPublicShare): string | null {
  if (!share.public_path || typeof window === 'undefined') return null;
  return `${window.location.origin}${share.public_path}`;
}

function ShareRow({
  share,
  onRevoke,
  isRevoking,
}: {
  share: SessionPublicShare;
  onRevoke: () => void;
  isRevoking: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const live = isShareLive(share);
  const url = shareUrl(share);
  const isFile = share.resource_type === 'file';

  const copy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    successToast('Public link copied');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <li
      className={cn(
        'group bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors',
        !live && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          live ? 'bg-kortix-green/15' : 'bg-muted',
        )}
      >
        {isFile ? (
          <FileText
            className={cn('size-5', live ? 'text-kortix-green' : 'text-muted-foreground')}
          />
        ) : (
          <Globe className={cn('size-5', live ? 'text-kortix-green' : 'text-muted-foreground')} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{share.label}</span>
          {!live && (
            <Badge variant="outline" size="xs">
              {share.revoked_at ? 'Revoked' : 'Expired'}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {isFile ? share.file_path : `Port ${share.port}${share.path}`}
        </p>
      </div>

      {live && (
        <span className="flex shrink-0 items-center gap-1">
          <Hint label={copied ? 'Copied' : 'Copy link'} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy link"
              disabled={!url}
              onClick={() => void copy()}
              className="size-8 active:scale-[0.96]"
            >
              {copied ? (
                <Check className="text-kortix-green size-4" />
              ) : (
                <Link2 className="size-4" />
              )}
            </Button>
          </Hint>
          <Button variant="ghost" size="sm" onClick={onRevoke} disabled={isRevoking}>
            {isRevoking ? <Loading className="size-4 shrink-0" /> : null}
            Revoke
          </Button>
        </span>
      )}
    </li>
  );
}

export function SessionSharesModal({
  projectId,
  sessionId,
  open,
  onOpenChange,
}: {
  projectId?: string;
  sessionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { shares, liveShares, isLoading, isError } = useSessionPublicShares(projectId, sessionId);
  const { revoke, revokingId } = useRevokePublicShare(projectId, sessionId);
  const [pendingRevoke, setPendingRevoke] = useState<SessionPublicShare | null>(null);

  const inactive = shares.filter((share) => !isShareLive(share));
  const listState = shareListState({ isLoading, isError, count: shares.length });

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>Public links</ModalTitle>
            <ModalDescription>
              Anyone with one of these links can view the resource without signing in. Revoking
              takes effect immediately.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-6 overflow-y-auto">
            {listState === 'loading' ? (
              <div className="flex justify-center py-6">
                <Loading className="size-4 shrink-0" />
              </div>
            ) : listState === 'error' ? (
              // The list 403s for a project member who neither created the
              // session nor has manage rights (`canManageSharing` = owner OR
              // project manager). Falling through to the empty state would tell
              // them nothing is shared, which may simply be false.
              <ErrorState
                size="sm"
                title="Can't show these links"
                description="Only the session's creator or a project manager can view and revoke its public links."
              />
            ) : listState === 'empty' ? (
              <EmptyState
                icon={Link2}
                size="sm"
                title="Nothing shared yet"
                description="Use Copy link on a file or app preview to create a public link."
              />
            ) : (
              <>
                {liveShares.length > 0 && (
                  <ul className="space-y-2">
                    {liveShares.map((share) => (
                      <ShareRow
                        key={share.share_id}
                        share={share}
                        isRevoking={revokingId === share.share_id}
                        onRevoke={() => setPendingRevoke(share)}
                      />
                    ))}
                  </ul>
                )}
                {inactive.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-muted-foreground text-xs">No longer active</p>
                    <ul className="space-y-2">
                      {inactive.map((share) => (
                        <ShareRow
                          key={share.share_id}
                          share={share}
                          isRevoking={false}
                          onRevoke={() => {}}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={!!pendingRevoke}
        onOpenChange={(next) => !next && setPendingRevoke(null)}
        title="Revoke this link?"
        description={
          <>
            <span className="font-medium">{pendingRevoke?.label}</span> will stop loading for
            everyone holding the link. This can&apos;t be undone — you can create a new link
            afterwards.
          </>
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        onConfirm={() => {
          if (pendingRevoke) revoke(pendingRevoke.share_id);
          setPendingRevoke(null);
        }}
      />
    </>
  );
}
