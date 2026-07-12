'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { useInstallMarketplaceItemAsSession } from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceSurface } from './marketplace-surface';
import { useProjectPicker } from './marketplace-project-picker';

/**
 * Merge a whole `registry:project` marketplace item into a project the user
 * already has — the alternative to `MarketplaceCloneButton` (which always
 * creates a brand-new project). Agent-driven: this starts a session with a
 * constructed prompt rather than committing files directly, since blindly
 * merging one project's kortix.yaml into another's is unsafe to do
 * deterministically (see `install-session` on the API).
 */
export function AddProjectToProjectModal({
  item,
  open,
  onOpenChange,
}: {
  item: MarketplaceItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const surface = useMarketplaceSurface();
  const install = useInstallMarketplaceItemAsSession();

  // On the in-project surface, default the picker to the project you're
  // already customizing — merging this catalog project into itself is the
  // most likely target — instead of an arbitrary first item.
  const { projects, projectsQuery, pickedProjectId, setPickedProjectId } = useProjectPicker({
    open,
    preferredProjectId: surface.variant === 'project' ? surface.projectId : undefined,
  });

  const guardedOpenChange = (next: boolean) => {
    if (install.isPending) return;
    onOpenChange(next);
  };

  const onSubmit = async () => {
    if (!item || !pickedProjectId || install.isPending) return;
    try {
      const res = await install.mutateAsync({ projectId: pickedProjectId, id: item.id });
      successToast('Session started', {
        description: `Watch the agent merge ${item.title} in.`,
      });
      onOpenChange(false);
      router.push(`/projects/${pickedProjectId}/sessions/${res.session_id}`);
    } catch (e) {
      errorToast('Could not start the session', { description: (e as Error).message });
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <Modal open={open} onOpenChange={guardedOpenChange}>
      <ModalContent className="lg:max-w-md" closeOnOutsideClick={!install.isPending}>
        <ModalHeader>
          <ModalTitle>Add {item?.title} to a project</ModalTitle>
          <ModalDescription>
            Starts a session where an agent merges this project&apos;s agent and skills into the
            one you pick — without touching anything already there.
          </ModalDescription>
        </ModalHeader>

        <form onSubmit={handleSubmit}>
          <ModalBody>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="mp-target-project">Project</FieldLabel>
                <Select value={pickedProjectId} onValueChange={setPickedProjectId}>
                  <SelectTrigger id="mp-target-project">
                    <SelectValue
                      placeholder={projectsQuery.isLoading ? 'Loading…' : 'Choose a project'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.project_id} value={p.project_id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!projectsQuery.isLoading && projects.length === 0 && (
                  <FieldDescription>
                    You don&apos;t have any projects yet — clone this as a new one instead.
                  </FieldDescription>
                )}
              </Field>

              {item && item.dependencies.length > 0 && (
                <FieldDescription>
                  Also installs: <span className="text-foreground">{item.dependencies.join(', ')}</span>
                </FieldDescription>
              )}
            </FieldGroup>
          </ModalBody>

          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              disabled={install.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!pickedProjectId || install.isPending}>
              {install.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
              {install.isPending ? 'Starting…' : 'Start'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
