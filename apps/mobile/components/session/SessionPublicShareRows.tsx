/**
 * SessionPublicShareRows — the top of the Share view (KRTX-248): native share
 * of the session's public transcript link and of a plain-text transcript.
 *
 * - Share link: reuses the live transcript share or mints one
 *   (`createSessionPublicShare(…, { transcript: true })` returns the live one
 *   when it exists), then opens the system share sheet with its `public_url`.
 *   iOS takes `url`; Android has no `url` field, so it gets the link as `message`.
 *   With no live link, a confirm comes first (web's `PublicShareLinkConfirm`
 *   wording: the link needs no sign-in); reusing a live link asks nothing. The
 *   confirm is a view pushed inside the same sheet (`SessionShareLinkConfirm`,
 *   `sheet-push`), never a dialog over it (Jay, 2026-09-27). A refusal toasts
 *   the API's own sentence (`publicLinkErrorMessage`).
 *   A server older than the `transcript` share kind ignores it and mints a
 *   `preview` share instead (still 201) — `guardTranscriptShare`
 *   (`lib/session/public-share-guard.ts`) catches any non-`transcript`
 *   `resource_type`, revokes it right away, and the URL is never shared.
 * - Share transcript: hidden until the device holds the session's messages.
 *   A tap first pages in the older history through the thread's own sync
 *   controller (`loadFullHistory`, at most 20 pages; the row reads
 *   "Loading…"), then shares `buildTranscriptText`. History still missing
 *   after that (bound hit, a failed page, or no open thread to page through)
 *   adds a "may not be included" line to the text.
 * - Stop sharing link: only while a live transcript share exists; revokes it
 *   after a destructive confirm, pushed the same way. The link then answers 410.
 *
 * Settings-list rows, no descriptions. Share link (when it confirms first) and
 * Stop sharing link push a view, so they keep the chevron.
 */
import * as React from 'react';
import { Platform, Share, View, type ShareContent } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { FileTextIcon, LinkBreakIcon, ShareNetworkIcon } from '@/lib/icons';
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
import { guardTranscriptShare } from '@/lib/session/public-share-guard';
import { buildTranscriptText } from '@/lib/session/transcript-text';

type SharesData = { shares: SessionPublicShare[] };

/** A confirm the Share view pushes in place of itself. */
export type PublicShareConfirmKind = 'create-link' | 'stop-link';

/**
 * The session's transcript share: the live-share query, the mint/reuse
 * mutation (which opens the system share sheet), and revoke. The rows and the
 * pushed confirm each mount it; both read the same cached share list.
 */
function usePublicTranscriptShare(projectId: string, session: ProjectSession) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const sessionId = session.session_id;
  const title = sessionDisplayTitle(session);
  const queryKey = projectKeys.sessionPublicShares(projectId, sessionId);

  const shares = useQuery({
    queryKey,
    queryFn: () => listSessionPublicShares(projectId, sessionId),
  });
  const activeShare = shares.data ? findActiveTranscriptShare(shares.data.shares) : null;

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
      const guard = guardTranscriptShare(share);
      if (!guard.ok) {
        // An API that predates the `transcript` kind ignored it and minted
        // something else (e.g. a public app-preview link). Never show or
        // share that URL — revoke it immediately and tell the user why.
        haptics.warning();
        toast.error(guard.message ?? PUBLIC_LINK_FALLBACK_ERROR);
        if (guard.shouldRevoke) {
          revokeSessionPublicShare(projectId, sessionId, share.share_id)
            .catch((error) => {
              console.warn('[public-share] failed to revoke a non-transcript share', share.share_id, error);
            })
            .finally(() => {
              void queryClient.invalidateQueries({ queryKey });
            });
        }
        return;
      }
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

  return { title, activeShare, openShareSheet, ensureLink, revoke };
}

export interface SessionPublicShareRowsProps {
  projectId: string;
  session: ProjectSession;
  /** Push a confirm view in place of the Share view. */
  onConfirm: (kind: PublicShareConfirmKind) => void;
}

export function SessionPublicShareRows({ projectId, session, onConfirm }: SessionPublicShareRowsProps) {
  const toast = useToast();
  const { title, activeShare, openShareSheet, ensureLink, revoke } = usePublicTranscriptShare(
    projectId,
    session
  );

  // The transcript comes from the sync store, keyed by the OpenCode session id.
  const runtimeSessionId = session.opencode_session_id;
  const hasMessages = useSyncStore((s) =>
    runtimeSessionId ? (s.messages[runtimeSessionId]?.length ?? 0) > 0 : false
  );

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
    <SettingsGroup>
      <SettingsRow
        icon={ShareNetworkIcon}
        label="Share link"
        value={ensureLink.isPending ? 'Creating…' : undefined}
        disabled={ensureLink.isPending}
        // A live link shares at once; without one the row pushes the confirm.
        right={activeShare ? null : undefined}
        onPress={() => {
          if (ensureLink.isPending) return;
          if (activeShare) {
            haptics.tap();
            ensureLink.mutate();
            return;
          }
          onConfirm('create-link');
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
          onPress={() => {
            if (revoke.isPending) return;
            onConfirm('stop-link');
          }}
        />
      ) : null}
    </SettingsGroup>
  );
}

const CONFIRM_COPY: Record<
  PublicShareConfirmKind,
  { description: string; label: string; pendingLabel: string; destructive: boolean }
> = {
  'create-link': {
    description:
      'Anyone with the link can view this without signing in. The link stays active until you revoke it.',
    label: 'Create link',
    pendingLabel: 'Creating…',
    destructive: false,
  },
  'stop-link': {
    description: 'The link stops working for everyone who has it.',
    label: 'Stop sharing',
    pendingLabel: 'Stopping…',
    destructive: true,
  },
};

/** The pushed view's title in the sheet's title row. */
export const PUBLIC_SHARE_CONFIRM_TITLE: Record<PublicShareConfirmKind, string> = {
  'create-link': 'Create a public link?',
  'stop-link': 'Stop sharing link',
};

export interface SessionShareLinkConfirmProps {
  projectId: string;
  session: ProjectSession;
  kind: PublicShareConfirmKind;
  /** The action succeeded: go back to the Share view. */
  onDone: () => void;
}

/**
 * The confirm the Share view pushes (`sheet-push`) before it mints or revokes
 * the public link: one sentence and one pill. Back in the title row cancels.
 * A failure toasts and keeps this view, so a retry is one tap.
 */
export function SessionShareLinkConfirm({ projectId, session, kind, onDone }: SessionShareLinkConfirmProps) {
  const { activeShare, ensureLink, revoke } = usePublicTranscriptShare(projectId, session);
  const copy = CONFIRM_COPY[kind];
  const pending = kind === 'create-link' ? ensureLink.isPending : revoke.isPending;

  const run = () => {
    if (pending) return;
    if (kind === 'create-link') {
      haptics.tap();
      // The system share sheet opens from the mutation's own onSuccess.
      ensureLink.mutate(undefined, { onSuccess: onDone });
      return;
    }
    if (!activeShare) {
      onDone();
      return;
    }
    haptics.warning();
    revoke.mutate(activeShare.share_id, { onSuccess: onDone });
  };

  return (
    <View className="gap-6 px-4 pt-1">
      <Text variant="muted" className="px-1">
        {copy.description}
      </Text>
      <Button
        size="lg"
        variant={copy.destructive ? 'destructive' : 'default'}
        className="rounded-full"
        disabled={pending}
        onPress={run}>
        <Text>{pending ? copy.pendingLabel : copy.label}</Text>
      </Button>
    </View>
  );
}
