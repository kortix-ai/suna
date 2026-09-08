'use client';

/**
 * Declare a space — name, one line of description, a default agent.
 *
 * That is the whole block (`spaces.<slug>` in `kortix.yaml`). Who may use it is granted on
 * its page; its scheduled work is filed from the project's triggers. Anything
 * richer belongs in the file itself, written by a person or an agent.
 *
 * The slug is derived server-side from the name (`slugify`), and it is
 * immutable — that is why it is not asked for here.
 */

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { createProjectSpace, getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Sentinel for "no default agent" — `''` is not a legal Radix item value. */
const NO_AGENT = '__none__';

export function CreateSpaceModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agent, setAgent] = useState(NO_AGENT);

  // The same `qk.project.detail` entry every other surface reads, so this
  // costs no extra request. `config.agents` is already narrowed server-side to
  // the agents this caller may use (`filterConfigResourcesForUser`), so there
  // is nothing to filter here beyond the two kinds a session cannot boot on.
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: open && !!projectId,
    ...contract('config'),
  });
  // Globals only: a space has no agents of its own before it exists,
  // and another space's agents are not usable here (spec 2026-09-06 §2).
  const agents = (detailQuery.data?.config?.agents ?? []).filter(
    (a) => a.enabled !== false && a.mode?.toLowerCase() !== 'subagent' && !a.space,
  );

  const reset = () => {
    setName('');
    setDescription('');
    setAgent(NO_AGENT);
  };

  const create = useMutation({
    mutationFn: () =>
      createProjectSpace(projectId, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(agent !== NO_AGENT ? { agent } : {}),
      }),
    onSuccess: async (space) => {
      successToast(`${space.name} created`);
      await queryClient.invalidateQueries({ queryKey: qk.project.spaces(projectId) });
      onOpenChange(false);
      reset();
      router.push(`/projects/${projectId}/spaces/${space.slug}`);
    },
    onError: (error: Error) => errorToast(error.message || 'Could not create the space'),
  });

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (create.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <ModalContent className="sm:max-w-md">
        <ModalHeader>
          <ModalTitle>New space</ModalTitle>
          <ModalDescription>
            A named container inside this project — its own sessions, its own default agent,
            and its own scheduled work.
          </ModalDescription>
        </ModalHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || create.isPending) return;
            create.mutate();
          }}
        >
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="space-name">Name</FieldLabel>
              <Input
                id="space-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Marketing"
                maxLength={64}
                autoFocus
                disabled={create.isPending}
              />
            </Field>

            <Field className="gap-1.5">
              <FieldLabel htmlFor="space-description">
                Description
                <span className="text-muted-foreground ml-2 text-xs font-normal">optional</span>
              </FieldLabel>
              <Input
                id="space-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Campaign work."
                maxLength={200}
                disabled={create.isPending}
              />
            </Field>

            <Field className="gap-1.5">
              <FieldLabel htmlFor="space-agent">
                Agent
                <span className="text-muted-foreground ml-2 text-xs font-normal">optional</span>
              </FieldLabel>
              <Select value={agent} onValueChange={setAgent} disabled={create.isPending}>
                <SelectTrigger id="space-agent">
                  <SelectValue placeholder="No default agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_AGENT}>No default agent</SelectItem>
                  {agents.map((option) => (
                    <SelectItem key={option.name} value={option.name}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                A default, not a binding — sessions started here open on it, and anyone using it
                still needs the agent in their own right.
              </FieldDescription>
            </Field>

          </ModalBody>

          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              disabled={create.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
              {create.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
              Create space
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
