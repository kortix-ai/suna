'use client';

import { useTranslations } from '../../../i18n';
import {
  type ConnectorPolicySet,
  deleteConnectorPolicySet,
  listConnectorPolicySets,
  renameConnectorPolicySet,
  upsertConnectorPolicySet,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';

import { Button } from '../../../primitives/button';
import { ButtonGroup } from '../../../primitives/button-group';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import { ErrorState } from '../../../primitives/error-state';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../../primitives/field';
import Hint from '../../../primitives/hint';
import { Input } from '../../../primitives/input';
import Loading from '../../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../../primitives/select';
import { Skeleton } from '../../../primitives/skeleton';
import { errorToast, successToast } from '../../../primitives/toast';

import { connectorPolicySetsKey, policySetNameProblem } from '../tools/policy-sets';

/** Select values that are not set names. A set name starts with [a-z0-9]. */
const BASE_VALUE = '__base';
const NEW_VALUE = '__new';

/**
 * The rule-list switcher above the Tools tab: "Base rules", each policy set,
 * and "New rule set…". A set gives the agents it is assigned to different
 * rules on this connector, with the same accounts.
 *
 * The bar owns create, edit (rename + description) and delete. The rules of
 * the selected set are edited by the Tools list below, through the one rule
 * writer (`PUT .../policies?policy_set=<name>`).
 *
 * Delete is refused while an agent uses the set: the list names the agents,
 * so the button is disabled with that reason, and a 409 from a concurrent
 * assignment surfaces the server's message naming them.
 */
export function ConnectorPolicySetBar({
  projectId,
  slug,
  canWrite,
  value,
  onChange,
}: {
  projectId: string;
  slug: string;
  canWrite: boolean;
  /** The selected set, or null for the base rules. */
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const t = useTranslations('connectorPolicySets');
  const queryClient = useQueryClient();
  const queryKey = connectorPolicySetsKey(projectId, slug);
  const setsQuery = useQuery({
    queryKey,
    queryFn: () => listConnectorPolicySets(projectId, slug),
    enabled: canWrite,
  });
  const sets: ConnectorPolicySet[] = setsQuery.data?.sets ?? [];
  const selected = value ? sets.find((set) => set.name === value) : undefined;

  // A set deleted or renamed elsewhere: fall back to the base rules instead of
  // editing a list that no longer exists.
  useEffect(() => {
    // Not while the list refetches: a set created or renamed a moment ago is
    // not in the stale list yet.
    if (value && setsQuery.isSuccess && !setsQuery.isFetching && !selected) onChange(null);
  }, [value, setsQuery.isSuccess, setsQuery.isFetching, selected, onChange]);

  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; set: ConnectorPolicySet } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ['connector-policies', projectId, slug] });
    // Rename and delete rewrite agent references in kortix.yaml.
    void queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
  };

  const remove = useMutation({
    mutationFn: (name: string) => deleteConnectorPolicySet(projectId, slug, name),
    onSuccess: (_result, name) => {
      successToast(t('deleted', { name }));
      onChange(null);
      setConfirmDelete(false);
      invalidate();
    },
    // 409 `policy_set_in_use`: the server's message names the agents.
    onError: (error: Error) => {
      setConfirmDelete(false);
      errorToast(error.message);
      invalidate();
    },
  });

  if (!canWrite) return null;
  if (setsQuery.isPending) return <Skeleton className="h-8 w-56 rounded-md" />;
  if (setsQuery.isError) {
    return (
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        description={setsQuery.error instanceof Error ? setsQuery.error.message : undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => void setsQuery.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  }

  const agents = selected?.agents ?? [];
  const agentList = agents.join(', ');

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value ?? BASE_VALUE}
          onValueChange={(next) => {
            if (next === NEW_VALUE) setEditor({ mode: 'create' });
            else onChange(next === BASE_VALUE ? null : next);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={t('rulesFor')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BASE_VALUE}>{t('baseRules')}</SelectItem>
            {sets.map((set) => (
              <SelectItem key={set.name} value={set.name} description={set.description ?? undefined}>
                <span className="font-mono">{set.name}</span>
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={NEW_VALUE}>{t('newSet')}</SelectItem>
          </SelectContent>
        </Select>
        {selected ? (
          <ButtonGroup>
            <Hint label={t('edit')}>
              <Button
                variant="outline"
                size="icon-base"
                aria-label={t('edit')}
                onClick={() => setEditor({ mode: 'edit', set: selected })}
              >
                <PencilSimpleIcon className="size-3.5 shrink-0" />
              </Button>
            </Hint>
            <Hint label={agents.length > 0 ? t('deleteInUse', { agents: agentList }) : t('delete')}>
              <Button
                variant="outline"
                size="icon-base"
                aria-label={t('delete')}
                disabled={agents.length > 0 || remove.isPending}
                onClick={() => setConfirmDelete(true)}
              >
                {remove.isPending ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <TrashIcon className="size-3.5 shrink-0" />
                )}
              </Button>
            </Hint>
          </ButtonGroup>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs text-pretty">
        {selected
          ? `${selected.description ? `${selected.description} · ` : ''}${
              agents.length > 0 ? t('usedBy', { agents: agentList }) : t('unused')
            }`
          : t('baseHint')}
      </p>
      {selected ? (
        <p className="text-muted-foreground text-xs text-pretty">
          {t('setHint', { name: selected.name })}
        </p>
      ) : null}

      <PolicySetEditor
        key={editor ? (editor.mode === 'edit' ? `edit:${editor.set.name}` : 'create') : 'closed'}
        projectId={projectId}
        slug={slug}
        state={editor}
        existing={sets.map((set) => set.name)}
        onOpenChange={(open) => !open && setEditor(null)}
        onSaved={(name) => {
          // Put the saved set in the cached list before selecting it, so the
          // stale-selection fallback above never sees it missing.
          const previous = editor?.mode === 'edit' ? editor.set : null;
          queryClient.setQueryData<{ sets: ConnectorPolicySet[] }>(queryKey, (current) => {
            const list = (current?.sets ?? []).filter((set) => set.name !== name && set.name !== previous?.name);
            const saved: ConnectorPolicySet = previous
              ? { ...previous, name }
              : { name, description: null, policies: [], agents: [] };
            return { sets: [...list, saved] };
          });
          setEditor(null);
          onChange(name);
          invalidate();
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={selected ? t('deleteTitle', { name: selected.name }) : ''}
        description={t('deleteBody')}
        confirmLabel={t('deleteConfirm')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => selected && remove.mutate(selected.name)}
      />
    </div>
  );
}

/**
 * Create a set, or rename it and change its description. A rename rewrites
 * every agent reference in the same kortix.yaml commit (server side), so an
 * agent never points at a missing set in between.
 */
function PolicySetEditor({
  projectId,
  slug,
  state,
  existing,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  slug: string;
  state: { mode: 'create' } | { mode: 'edit'; set: ConnectorPolicySet } | null;
  existing: readonly string[];
  onOpenChange: (open: boolean) => void;
  onSaved: (name: string) => void;
}) {
  const t = useTranslations('connectorPolicySets');
  const id = useId();
  const current = state?.mode === 'edit' ? state.set : null;
  const [name, setName] = useState(current?.name ?? '');
  const [description, setDescription] = useState(current?.description ?? '');
  const trimmed = name.trim();
  const problem = trimmed ? policySetNameProblem(trimmed, existing, current?.name ?? null) : null;

  const save = useMutation({
    mutationFn: async () => {
      const nextDescription = description.trim() || null;
      if (!current) {
        await upsertConnectorPolicySet(projectId, slug, trimmed, { description: nextDescription });
        return { name: trimmed, created: true };
      }
      if (trimmed !== current.name) {
        await renameConnectorPolicySet(projectId, slug, current.name, trimmed);
      }
      if (nextDescription !== (current.description ?? null)) {
        await upsertConnectorPolicySet(projectId, slug, trimmed, { description: nextDescription });
      }
      return { name: trimmed, created: false };
    },
    onSuccess: (result) => {
      successToast(result.created ? t('created', { name: result.name }) : t('saved'));
      onSaved(result.name);
    },
    onError: (error: Error) => errorToast(error.message),
  });

  const pending = save.isPending;
  const valid = trimmed !== '' && problem === null;

  return (
    <Modal open={state !== null} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{current ? t('editTitle') : t('createTitle')}</ModalTitle>
          <ModalDescription>{current ? t('editBody') : t('createBody')}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !pending) save.mutate();
          }}
        >
          <ModalBody>
            <FieldGroup>
              <Field data-invalid={problem ? true : undefined}>
                <FieldLabel htmlFor={`${id}-name`}>{t('nameLabel')}</FieldLabel>
                <Input
                  id={`${id}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="read_only"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={problem ? true : undefined}
                  disabled={pending}
                  autoFocus
                />
                <FieldDescription className={problem ? 'text-destructive' : undefined}>
                  {problem === 'taken' ? t('nameTaken') : t('nameHelp')}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-description`}>{t('descriptionLabel')}</FieldLabel>
                <Input
                  id={`${id}-description`}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('descriptionPlaceholder')}
                  autoComplete="off"
                  disabled={pending}
                />
              </Field>
            </FieldGroup>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? <Loading className="size-4 shrink-0" /> : null}
              {current ? t('save') : t('create')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
