'use client';

import { KeyRound, Plug, Wrench } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';

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
import { startTemplateSetupSession } from '@/features/projects/modal/template-setup-session';
import { useInstallMarketplaceItemAsSession } from '@/hooks/marketplace';
import { isManagedGitUnavailableError } from '@/lib/onboarding/ensure-first-project';
import type { MarketplaceItem, MarketplaceItemDetail } from '@/lib/marketplace-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts, provisionProject } from '@kortix/sdk/projects-client';
import { capabilityCount, hasCapabilities } from './marketplace-install';
import { useProjectPicker } from './marketplace-project-picker';

/** Sentinel `Select` value for "create a new project" (real project ids are
 *  UUIDs, so this can never collide). */
const NEW_PROJECT = '__new__';

/**
 * The ONE "install this marketplace item" modal — replaces the old
 * clone-a-project / add-a-skill / merge-a-project-into-a-project fork with a
 * single target choice (an existing project, or a brand new one, provisioned
 * inline). Installing is always an agent import: a session clones the item's
 * source repo, reads it, and merges what fits into the project's own files.
 */
export function AddToProjectModal({
  item,
  open,
  onOpenChange,
  fixedProjectId,
}: {
  item: MarketplaceItemDetail | MarketplaceItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selects this project as the target (still switchable — not a lock). */
  fixedProjectId?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isProject = item.type === 'registry:project';
  const humanizedTitle = item.title.replaceAll('-', ' ');

  const { projects, projectsQuery } = useProjectPicker({
    open,
    preferredProjectId: fixedProjectId,
  });

  const [target, setTarget] = useState<string>(fixedProjectId ?? NEW_PROJECT);
  const [newProjectName, setNewProjectName] = useState(humanizedTitle);
  const [busy, setBusy] = useState(false);

  const installSession = useInstallMarketplaceItemAsSession();

  // Reset to sensible defaults each time the modal opens for a (possibly new) item.
  useEffect(() => {
    if (!open) return;
    setTarget(fixedProjectId ?? NEW_PROJECT);
    setNewProjectName(humanizedTitle);
  }, [open, fixedProjectId, humanizedTitle]);

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
    // NEW_PROJECT branch.
    let resolvedAccountId: string | null = null;
    try {
      if (target === NEW_PROJECT) {
        const accounts = await listAccounts();
        // No `personal_account` flag on this API — the bootstrapped personal
        // account is the one where the caller is the primary owner.
        const account = accounts.find((a) => a.is_primary_owner) ?? accounts[0];
        if (!account) throw new Error('No account available to create a project in');
        resolvedAccountId = account.account_id;

        const project = await provisionProject({
          account_id: account.account_id,
          name: newProjectName.trim() || humanizedTitle,
          starter_template: 'general-knowledge-worker',
          source_item_id: isProject ? item.id : undefined,
        });
        queryClient.invalidateQueries({ queryKey: ['projects'] });

        const sessionId = isProject
          ? await startTemplateSetupSession(project, { itemId: item.id, title: item.title })
          : (await installSession.mutateAsync({ projectId: project.project_id, id: item.id }))
              .session_id;
        onOpenChange(false);
        router.replace(
          sessionId
            ? `/projects/${project.project_id}/sessions/${sessionId}`
            : `/projects/${project.project_id}`,
        );
        return;
      }

      const projectId = target;
      const { session_id } = await installSession.mutateAsync({ projectId, id: item.id });
      onOpenChange(false);
      router.push(`/projects/${projectId}/sessions/${session_id}`);
    } catch (e) {
      if (isManagedGitUnavailableError(e)) {
        const gitSettingsAccountId =
          resolvedAccountId ?? useCurrentAccountStore.getState().selectedAccountId;
        errorToast("Managed git isn't set up on this server", {
          description: 'An admin needs to connect GitHub in Git settings before projects can be created.',
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
        errorToast('Could not add to project', { description: (e as Error).message });
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
    busy || (target === NEW_PROJECT && newProjectName.trim().length === 0);

  return (
    <Modal open={open} onOpenChange={guardedOpenChange}>
      <ModalContent className="lg:max-w-md" closeOnOutsideClick={!busy}>
        <ModalHeader>
          <ModalTitle>Add {humanizedTitle} to a project</ModalTitle>
        </ModalHeader>

        <form onSubmit={handleSubmit}>
          <ModalBody>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="mp-target-project">Project</FieldLabel>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id="mp-target-project">
                    <SelectValue
                      placeholder={projectsQuery.isLoading ? 'Loading…' : 'Choose a project'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NEW_PROJECT}>＋ New project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.project_id} value={p.project_id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {target === NEW_PROJECT && (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="mp-new-project-name">Name</FieldLabel>
                  <Input
                    id="mp-new-project-name"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder={humanizedTitle}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>
              )}

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
              {busy ? 'Adding…' : 'Add to project'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
