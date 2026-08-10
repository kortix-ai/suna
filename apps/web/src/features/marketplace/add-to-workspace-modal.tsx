'use client';

import { KeyIcon as KeyRound, PlugIcon as Plug, WrenchIcon as Wrench } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast } from '@/components/ui/toast';
import {
  GitHubSetupRequiredPanel,
  isAccountGitAdmin,
} from '@/features/workspaces/modal/github-setup-required-panel';
import { startTemplateSetupSession } from '@/features/workspaces/modal/template-setup-session';
import { useInstallMarketplaceItemAsSession } from '@/hooks/marketplace';
import type { MarketplaceItem, MarketplaceItemDetail } from '@/lib/marketplace-client';
import { isManagedGitUnavailableError } from '@/lib/onboarding/ensure-first-workspace';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useCustomizeStore } from '@/stores/customize-store';
import { getManagedGitStatus, listAccounts, provisionWorkspace } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { capabilityCount, hasCapabilities } from './marketplace-install';
import { prepareMarketplaceInstallSessionNavigation } from './marketplace-session-navigation';
import { useWorkspacePicker } from './marketplace-workspace-picker';

/** Sentinel `Select` value for "create a new workspace" (real workspace ids are
 *  UUIDs, so this can never collide). */
const NEW_WORKSPACE = '__new__';

/**
 * The ONE "install this marketplace item" modal — replaces the old
 * clone-a-workspace / add-a-skill / merge-a-workspace-into-a-workspace fork with a
 * single target choice (an existing workspace, or a brand new one, provisioned
 * inline). Installing is always an agent import: a session clones the item's
 * source repo, reads it, and merges what fits into the workspace's own files.
 */
export function AddToWorkspaceModal({
  item,
  open,
  onOpenChange,
  fixedWorkspaceId,
}: {
  item: MarketplaceItemDetail | MarketplaceItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selects this workspace as the target (still switchable — not a lock). */
  fixedWorkspaceId?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const closeCustomize = useCustomizeStore((s) => s.close);
  const isWorkspaceItem = item.type === 'registry:project';
  const humanizedTitle = item.title.replaceAll('-', ' ');

  const { workspaces, workspacesQuery } = useWorkspacePicker({
    open,
    preferredWorkspaceId: fixedWorkspaceId,
  });

  const [target, setTarget] = useState<string>(fixedWorkspaceId ?? NEW_WORKSPACE);
  const [newWorkspaceName, setNewWorkspaceName] = useState(humanizedTitle);
  const [busy, setBusy] = useState(false);

  const installSession = useInstallMarketplaceItemAsSession();

  // Pre-check managed git the same way the New Workspace modal does — self-host
  // with nothing configured should route to Git settings instead of letting
  // the "new workspace" target hit the provision 503 first.
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
    enabled: open && target === NEW_WORKSPACE,
  });
  // No `personal_account` flag on this API — the bootstrapped personal
  // account is the one where the caller is the primary owner. Mirrors the
  // resolution in `onConfirm` below.
  const candidateAccount = useMemo(() => {
    const accounts = accountsQuery.data ?? [];
    return accounts.find((a) => a.is_primary_owner) ?? accounts[0] ?? null;
  }, [accountsQuery.data]);
  const isGitAdmin = isAccountGitAdmin(candidateAccount?.account_role);

  const managedGitStatusQuery = useQuery({
    queryKey: ['managed-git-status'],
    queryFn: getManagedGitStatus,
    staleTime: 10_000,
    enabled: open && target === NEW_WORKSPACE,
  });
  const managedGitUnavailable =
    target === NEW_WORKSPACE && managedGitStatusQuery.data?.configured === false;

  // Reset to sensible defaults each time the modal opens for a (possibly new) item.
  useEffect(() => {
    if (!open) return;
    setTarget(fixedWorkspaceId ?? NEW_WORKSPACE);
    setNewWorkspaceName(humanizedTitle);
  }, [open, fixedWorkspaceId, humanizedTitle]);

  const caps = item.capabilities;
  const showCaps = hasCapabilities(caps);
  const capCount = capabilityCount(caps);

  const guardedOpenChange = (next: boolean) => {
    // Block the modal from closing mid-flight — losing the pending/error
    // feedback would leave the user unsure whether the request landed.
    if (busy) return;
    onOpenChange(next);
  };

  const onConfirm = async () => {
    if (busy) return;
    setBusy(true);
    // Tracked outside the try so the managed-git-unavailable catch below can
    // still point at the right account even though it's only resolved in the
    // NEW_WORKSPACE branch.
    let resolvedAccountId: string | null = null;
    try {
      if (target === NEW_WORKSPACE) {
        const accounts = await listAccounts();
        // No `personal_account` flag on this API — the bootstrapped personal
        // account is the one where the caller is the primary owner.
        const account = accounts.find((a) => a.is_primary_owner) ?? accounts[0];
        if (!account) throw new Error('No account available to create a workspace in');
        resolvedAccountId = account.account_id;

        const workspace = await provisionWorkspace({
          account_id: account.account_id,
          name: newWorkspaceName.trim() || humanizedTitle,
          starter_template: 'general-knowledge-worker',
          source_item_id: isWorkspaceItem ? item.id : undefined,
        });
        // qk.workspaces.scope(): restores the reach the old bare
        // projects-literal prefix match had — every account's list, and the
        // accountless slot the marketplace picker itself reads.
        queryClient.invalidateQueries({ queryKey: qk.workspaces.scope() });

        const sessionId = isWorkspaceItem
          ? await startTemplateSetupSession(workspace, { itemId: item.id, title: item.title })
          : (await installSession.mutateAsync({ workspaceId: workspace.workspace_id, id: item.id }))
              .session_id;
        const sessionHref = prepareMarketplaceInstallSessionNavigation(
          queryClient,
          router,
          workspace.workspace_id,
          sessionId,
        );
        onOpenChange(false);
        closeCustomize();
        router.replace(sessionHref ?? `/workspaces/${workspace.workspace_id}`);
        return;
      }

      const workspaceId = target;
      const { session_id } = await installSession.mutateAsync({ workspaceId, id: item.id });
      const sessionHref = prepareMarketplaceInstallSessionNavigation(
        queryClient,
        router,
        workspaceId,
        session_id,
      );
      onOpenChange(false);
      closeCustomize();
      router.push(sessionHref ?? `/workspaces/${workspaceId}`);
    } catch (e) {
      if (isManagedGitUnavailableError(e)) {
        const gitSettingsAccountId =
          resolvedAccountId ?? useCurrentAccountStore.getState().selectedAccountId;
        errorToast("Managed git isn't set up on this server", {
          description:
            'An admin needs to connect GitHub in Git settings before workspaces can be created.',
          ...(gitSettingsAccountId
            ? {
                button: (
                  <Button
                    size="sm"
                    onClick={() => {
                      onOpenChange(false);
                      router.push(`/accounts/${gitSettingsAccountId}?tab=git`);
                    }}
                  >
                    Open Git settings
                  </Button>
                ),
              }
            : {}),
        });
      } else {
        errorToast('Could not add to workspace', { description: (e as Error).message });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onConfirm();
  };

  const confirmDisabled =
    busy ||
    (target === NEW_WORKSPACE && (managedGitUnavailable || newWorkspaceName.trim().length === 0));

  return (
    <Modal open={open} onOpenChange={guardedOpenChange}>
      <ModalContent className="lg:max-w-md" closeOnOutsideClick={!busy}>
        <ModalHeader>
          <ModalTitle>Add {humanizedTitle} to a workspace</ModalTitle>
        </ModalHeader>

        <form onSubmit={handleSubmit}>
          <ModalBody>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="mp-target-workspace">Workspace</FieldLabel>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id="mp-target-workspace">
                    <SelectValue
                      placeholder={workspacesQuery.isLoading ? 'Loading…' : 'Choose a workspace'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NEW_WORKSPACE}>＋ New workspace</SelectItem>
                    {workspaces.map((workspace) => (
                      <SelectItem key={workspace.workspace_id} value={workspace.workspace_id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {target === NEW_WORKSPACE && managedGitUnavailable ? (
                <GitHubSetupRequiredPanel
                  accountId={candidateAccount?.account_id ?? null}
                  isAdmin={isGitAdmin}
                  onNavigate={() => onOpenChange(false)}
                  size="sm"
                />
              ) : target === NEW_WORKSPACE ? (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="mp-new-workspace-name">Name</FieldLabel>
                  <Input
                    id="mp-new-workspace-name"
                    value={newWorkspaceName}
                    onChange={(e) => setNewWorkspaceName(e.target.value)}
                    placeholder={humanizedTitle}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>
              ) : null}

              {item.dependencies.length > 0 && (
                <FieldDescription>
                  Also installs:{' '}
                  <span className="text-foreground">{item.dependencies.join(', ')}</span>
                </FieldDescription>
              )}

              {showCaps ? (
                <Field variant="outline">
                  <FieldContent>
                    <div className="flex items-center gap-2">
                      <FieldTitle>This item requires</FieldTitle>
                      <Badge variant="outline" size="sm">
                        {capCount}
                      </Badge>
                    </div>
                    <ul className="mt-2 space-y-1.5">
                      {caps?.secrets.map((s) => (
                        <li key={s} className="flex items-center gap-2.5">
                          <span className="bg-kortix-yellow/15 text-kortix-yellow flex size-6 shrink-0 items-center justify-center rounded-sm">
                            <KeyRound className="size-3.5" />
                          </span>
                          <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                            {s}
                          </span>
                          <Badge variant="outline" size="sm">
                            Secret
                          </Badge>
                        </li>
                      ))}
                      {caps?.connectors.map((c) => (
                        <li key={c} className="flex items-center gap-2.5">
                          <span className="bg-kortix-blue/15 text-kortix-blue flex size-6 shrink-0 items-center justify-center rounded-sm">
                            <Plug className="size-3.5" />
                          </span>
                          <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                            {c}
                          </span>
                          <Badge variant="outline" size="sm">
                            Connector
                          </Badge>
                        </li>
                      ))}
                      {caps?.tools.map((t) => (
                        <li key={t} className="flex items-center gap-2.5">
                          <span className="bg-kortix-orange/15 text-kortix-orange flex size-6 shrink-0 items-center justify-center rounded-sm">
                            <Wrench className="size-3.5" />
                          </span>
                          <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                            {t}
                          </span>
                          <Badge variant="outline" size="sm">
                            Tool
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </FieldContent>
                </Field>
              ) : (
                <FieldDescription>No special requirements — this item just works.</FieldDescription>
              )}
            </FieldGroup>
          </ModalBody>

          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={confirmDisabled}>
              {busy ? <Loading className="size-3.5 shrink-0" /> : null}
              {busy ? 'Adding…' : 'Add to workspace'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
