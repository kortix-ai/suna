/**
 * SessionPublicShareRows — the top of the Share view (KRTX-248): native share
 * of the session's public transcript link and of a plain-text transcript.
 *
 * - Share link: reuses the live transcript share or mints one
 *   (`createSessionPublicShare(…, { transcript: true })` returns the live one
 *   when it exists), then opens the system share sheet with its `public_url`.
 *   iOS takes `url`; Android has no `url` field, so it gets the link as `message`.
 *   With no live link, a confirm comes first (web's `PublicShareLinkConfirm`
 *   wording: the link needs no sign-in); reusing a live link asks nothing. A
 *   refusal toasts the API's own sentence (`publicLinkErrorMessage`).
 * - Share transcript: hidden until the device holds the session's messages.
 *   A tap first pages in the older history through the thread's own sync
 *   controller (`loadFullHistory`, at most 20 pages; the row reads
 *   "Loading…"), then shares `buildTranscriptText`. History still missing
 *   after that (bound hit, a failed page, or no open thread to page through)
 *   adds a "may not be included" line to the text.
 * - Stop sharing link: only while a live transcript share exists; revokes it
 *   after a destructive confirm. The link then answers 410.
 *
 * Settings-list rows, no descriptions, no chevrons: none of them pushes a view.
 */
import * as React from 'react';
import { Platform, Share, type ShareContent } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useConfirmDialog } from '@/components/kortix/confirm-dialog';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { FileTextIcon, LinkBreakIcon, LinkIcon } from '@/lib/icons';
import { loadFullHistory } from '@/lib/opencode/session-sync';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { projectKeys } from '@/lib/projects/hooks';
import {
  createSessionPublicShare,
  findActiveTranscriptShare,
  listSessionPublicShares,
  revokeSessionPublicShare,
  type ProjectSession,
  type SessionPublicShare,
} from '@/lib/projects/projects-client';
import { sessionDisplayTitle } from '@/lib/session/session-list';
import { PUBLIC_LINK_FALLBACK_ERROR, publicLinkErrorMessage } from '@/lib/session/public-share-error';
import { buildTranscriptText } from '@/lib/session/transcript-text';

type SharesData = { shares: SessionPublicShare[] };

export interface SessionPublicShareRowsProps {
  projectId: string;
  session: ProjectSession;
}

export function SessionPublicShareRows({ projectId, session }: SessionPublicShareRowsProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { confirm, dialog } = useConfirmDialog();

  const sessionId = session.session_id;
  const title = sessionDisplayTitle(session);
  const queryKey = projectKeys.sessionPublicShares(projectId, sessionId);

  const shares = useQuery({
    queryKey,
    queryFn: () => listSessionPublicShares(projectId, sessionId),
  });
  const activeShare = shares.data ? findActiveTranscriptShare(shares.data.shares) : null;

  // The transcript comes from the sync store, keyed by the OpenCode session id.
  const runtimeSessionId = session.opencode_session_id;
  const hasMessages = useSyncStore((s) =>
    runtimeSessionId ? (s.messages[runtimeSessionId]?.length ?? 0) > 0 : false
  );

  const openShareSheet = React.useCallback(
    async (content: ShareContent) => {
      try {
        await Share.share(content, { subject: title });
      } catch {
        haptics.warning();
        toast.error('Unable to open sharing. Try again.');
      }
    },
    [title, toast]
  );

  const ensureLink = useMutation({
    // A live share is reused; otherwise the server mints one. A tap before the
    // list has loaded (or from a second device) relies on the create route
    // returning the existing live share (200) instead of a second link.
    mutationFn: async () =>
      activeShare ?? (await createSessionPublicShare(projectId, sessionId, { transcript: true })).share,
    onSuccess: (share) => {
      queryClient.setQueryData<SharesData>(queryKey, (old) => {
        const list = old?.shares ?? [];
        return list.some((s) => s.share_id === share.share_id) ? old : { shares: [share, ...list] };
      });
      const url = share.public_url;
      if (!url) {
        haptics.warning();
        toast.error(PUBLIC_LINK_FALLBACK_ERROR);
        return;
      }
      void openShareSheet(Platform.OS === 'ios' ? { url } : { message: url });
    },
    onError: (error) => {
      haptics.warning();
      toast.error(publicLinkErrorMessage(error));
    },
  });

  const revoke = useMutation({
    mutationFn: (shareId: string) => revokeSessionPublicShare(projectId, sessionId, shareId),
    onSuccess: () => {
      haptics.success();
      toast.success('Link stopped');
    },
    onError: () => {
      haptics.warning();
      toast.error('Unable to stop the link. Try again.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const [loadingHistory, setLoadingHistory] = React.useState(false);
  // False once the Share view unmounts (Back, sheet closed): a history load
  // still running then must not open the share sheet or a toast.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const shareTranscript = async () => {
    if (!runtimeSessionId || loadingHistory) return;
    haptics.tap();
    setLoadingHistory(true);
    let complete = false;
    try {
      ({ complete } = await loadFullHistory(runtimeSessionId));
    } finally {
      if (mountedRef.current) setLoadingHistory(false);
    }
    if (!mountedRef.current) return;
    const messages = useSyncStore.getState().messages[runtimeSessionId];
    const text = messages ? buildTranscriptText(title, messages, { incomplete: !complete }) : null;
    if (!text) {
      toast.error('Nothing to share yet.');
      return;
    }
    void openShareSheet({ message: text });
  };

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          icon={LinkIcon}
          label="Share link"
          value={ensureLink.isPending ? 'Creating…' : undefined}
          disabled={ensureLink.isPending}
          right={null}
          onPress={() => {
            if (ensureLink.isPending) return;
            haptics.tap();
            if (activeShare) {
              ensureLink.mutate();
              return;
            }
            // A new public link is a decision: web's PublicShareLinkConfirm wording.
            confirm({
              title: 'Create a public link?',
              description:
                'Anyone with the link can view this without signing in. The link stays active until you revoke it.',
              confirmLabel: 'Create link',
              onConfirm: () => ensureLink.mutate(),
            });
          }}
        />
        {hasMessages ? (
          <SettingsRow
            icon={FileTextIcon}
            label="Share transcript"
            value={loadingHistory ? 'Loading…' : undefined}
            disabled={loadingHistory}
            right={null}
            onPress={() => void shareTranscript()}
          />
        ) : null}
        {activeShare ? (
          <SettingsRow
            icon={LinkBreakIcon}
            label="Stop sharing link"
            destructive
            value={revoke.isPending ? 'Stopping…' : undefined}
            disabled={revoke.isPending}
            right={null}
            onPress={() => {
              if (revoke.isPending) return;
              haptics.warning();
              confirm({
                title: 'Stop sharing link',
                description: 'The link stops working for everyone who has it.',
                confirmLabel: 'Stop sharing',
                destructive: true,
                onConfirm: () => revoke.mutate(activeShare.share_id),
              });
            }}
          />
        ) : null}
      </SettingsGroup>
      {dialog}
    </>
  );
}
