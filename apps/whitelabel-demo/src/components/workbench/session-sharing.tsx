'use client';

/**
 * Session sharing for the preview panel: the visibility row with its
 * create-share dialog, and the public-shares list with its revoke. Both own
 * their mutations; PreviewPanel keeps only the preview surface itself.
 */

import Loading from '@kortix/ui/loading';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@kortix/ui/modal';
import { Input } from '@kortix/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { Separator } from '@kortix/ui/separator';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { resolvePublicShareUrl } from '@kortix/sdk';
import type { SessionPreviewCandidate, SessionPublicShare } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorToast, successToast } from '@kortix/ui/toast';
import { CopyIcon, PlusIcon, ShareNetworkIcon, TrashIcon } from '@phosphor-icons/react';

// Session sharing intent — a subset of the SDK's ConnectorSharing union that
// needs no extra ids (private requires an ownerId, so it's omitted here).
const SHARING_OPTIONS = [
  { value: 'project', label: 'Everyone in project', intent: { mode: 'project' } as const },
  { value: 'members', label: 'Specific members only', intent: { mode: 'members' } as const },
];

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    successToast('Copied to clipboard');
  } catch {
    errorToast('Could not copy');
  }
}

/** The create-share dialog: its trigger, form state, and mint mutation. */
function CreateShareDialog({
  projectId,
  sessionId,
  selected,
}: {
  projectId: string;
  sessionId: string;
  selected: SessionPreviewCandidate | null;
}) {
  const qc = useQueryClient();
  const session = kortix.session(projectId, sessionId);

  // Create-share dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [shareLabel, setShareLabel] = useState('');
  const [shareInteractive, setShareInteractive] = useState('interactive');

  const createMut = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('No preview selected');
      return session.publicShares.create({
        preview_id: selected.id,
        preview: {
          label: selected.label,
          port: selected.port,
          path: selected.path,
        },
        mode: shareInteractive === 'interactive' ? 'interactive' : 'view',
        label: shareLabel.trim() || selected.label,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessionShares(projectId, sessionId) });
      successToast('Public share created');
      setCreateOpen(false);
      setShareLabel('');
    },
    onError: (err: unknown) =>
      errorToast(err instanceof Error ? err.message : 'Failed to create share'),
  });

  return (
    <Modal open={createOpen} onOpenChange={setCreateOpen}>
      <ModalTrigger asChild>
        <Button variant="secondary" size="sm" className="ml-auto h-8 gap-1.5" disabled={!selected}>
          <PlusIcon className="size-3.5" />
          Create public share
        </Button>
      </ModalTrigger>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Create public share</ModalTitle>
          <ModalDescription>
            Mint a public link for{' '}
            <span className="font-mono text-foreground">
              {selected ? `:${selected.port}${selected.path ?? ''}` : 'the preview'}
            </span>
            .
          </ModalDescription>
        </ModalHeader>
        <CreateShareForm
          selected={selected}
          shareLabel={shareLabel}
          setShareLabel={setShareLabel}
          shareInteractive={shareInteractive}
          setShareInteractive={setShareInteractive}
          setCreateOpen={setCreateOpen}
          createMut={createMut}
        />
      </ModalContent>
    </Modal>
  );
}

/** The create-share form: its label and mode fields plus the create/cancel actions. */
function CreateShareForm({
  selected,
  shareLabel,
  setShareLabel,
  shareInteractive,
  setShareInteractive,
  setCreateOpen,
  createMut,
}: {
  selected: SessionPreviewCandidate | null;
  shareLabel: string;
  setShareLabel: (value: string) => void;
  shareInteractive: string;
  setShareInteractive: (value: string) => void;
  setCreateOpen: (open: boolean) => void;
  createMut: { isPending: boolean; mutate: () => void };
}) {
  return (
    <>
      <ModalBody className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Label</label>
          <Input
            value={shareLabel}
            onChange={(e) => setShareLabel(e.target.value)}
            placeholder={selected?.label || 'My preview'}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Mode</label>
          <Select value={shareInteractive} onValueChange={setShareInteractive}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="interactive" className="text-xs">
                Interactive
              </SelectItem>
              <SelectItem value="view" className="text-xs">
                View only
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCreateOpen(false)}
          disabled={createMut.isPending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending || !selected}
        >
          {createMut.isPending ? <Loading className="size-3.5" /> : <ShareNetworkIcon className="size-3.5" />}
          Create link
        </Button>
      </ModalFooter>
    </>
  );
}

export function SessionSharing({
  projectId,
  sessionId,
  selected,
}: {
  projectId: string;
  sessionId: string;
  selected: SessionPreviewCandidate | null;
}) {
  const qc = useQueryClient();
  const session = kortix.session(projectId, sessionId);

  const sessionQuery = useQuery({
    queryKey: qk.session(projectId, sessionId),
    queryFn: () => session.get({ showErrors: false }),
  });
  const sharingMode = sessionQuery.data?.sharing?.mode ?? '';
  const setSharingMut = useMutation({
    mutationFn: (value: string) => {
      const opt = SHARING_OPTIONS.find((o) => o.value === value);
      if (!opt) throw new Error('Unsupported sharing mode');
      return session.setSharing(opt.intent);
    },
    onSuccess: (data) => {
      qc.setQueryData(qk.session(projectId, sessionId), data);
      qc.invalidateQueries({ queryKey: qk.session(projectId, sessionId) });
      qc.invalidateQueries({ queryKey: qk.sessionShares(projectId, sessionId) });
      successToast('Sharing updated');
    },
    onError: (err: unknown) =>
      errorToast(err instanceof Error ? err.message : 'Failed to update sharing'),
  });

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <ShareNetworkIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Session visibility</span>
      <Select
        value={sharingMode}
        onValueChange={(v) => setSharingMut.mutate(v)}
        disabled={setSharingMut.isPending || !sessionQuery.data}
      >
        <SelectTrigger className="h-8 w-[200px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="private" disabled className="text-xs">
            Private
          </SelectItem>
          {SHARING_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {setSharingMut.isPending && <Loading className="size-3.5 text-muted-foreground" />}

      <CreateShareDialog projectId={projectId} sessionId={sessionId} selected={selected} />
    </div>
  );
}

/** One public-share row: its label, resolved URL, and copy/revoke actions. */
function ShareRow({
  share,
  url,
  revoked,
  revokeMut,
}: {
  share: SessionPublicShare;
  url: string;
  revoked: boolean;
  revokeMut: { isPending: boolean; mutate: (shareId: string) => void };
}) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-foreground">
            {share.label || `Port ${share.port ?? '—'}`}
          </span>
          {revoked ? (
            <Badge variant="destructive" className="px-1.5 py-0 text-[0.65rem]">
              revoked
            </Badge>
          ) : (
            <Badge variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
              {share.mode || 'view'}
            </Badge>
          )}
        </div>
        <p className="truncate font-mono text-[0.7rem] text-muted-foreground">{url || '—'}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        disabled={!url}
        onClick={() => copy(url)}
        title="Copy URL"
      >
        <CopyIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-destructive hover:text-destructive"
        disabled={revoked || revokeMut.isPending}
        onClick={() => revokeMut.mutate(share.share_id)}
        title="Revoke share"
      >
        <TrashIcon className="size-3.5" />
      </Button>
    </li>
  );
}

/** The public shares for this session, with their copy and revoke actions. */
export function PublicSharesList({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const qc = useQueryClient();
  const session = kortix.session(projectId, sessionId);

  const sharesQuery = useQuery({
    queryKey: qk.sessionShares(projectId, sessionId),
    queryFn: () => session.publicShares.list(),
  });

  const revokeMut = useMutation({
    mutationFn: (shareId: string) => session.publicShares.revoke(shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessionShares(projectId, sessionId) });
      successToast('Share revoked');
    },
    onError: (err: unknown) =>
      errorToast(err instanceof Error ? err.message : 'Failed to revoke share'),
  });

  const shares = sharesQuery.data?.shares ?? [];

  return (
    <div className="shrink-0 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">Public shares</span>
        <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
          {shares.length}
        </Badge>
        {sharesQuery.isFetching && <Loading className="size-3 text-muted-foreground" />}
      </div>
      <Separator />
      {shares.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          No public links yet. Create one to share this preview outside the workspace.
        </p>
      ) : (
        <ul className="max-h-48 space-y-1.5 overflow-auto scrollbar-thin">
          {shares.map((share) => {
            // Relative paths resolve against this page's origin; the SDK
            // function owns the field fallback order beside the type.
            const url = resolvePublicShareUrl(
              share,
              typeof window !== 'undefined' ? window.location.origin : undefined,
            );
            const revoked = !!share.revoked_at;
            return (
              <ShareRow
                key={share.share_id}
                share={share}
                url={url}
                revoked={revoked}
                revokeMut={revokeMut}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
