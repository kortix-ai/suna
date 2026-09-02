'use client';

import { SparkleIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useProjectSubprojects } from '@kortix/sdk/react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
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
import { Textarea } from '@/components/ui/textarea';
import { errorToast } from '@/components/ui/toast';
import { prepareInstallSessionNavigation } from '../session/install-session-navigation';

/** The server's bound. Enforced here too so the field can say so before submit. */
const MAX_DESCRIPTION = 4000;

/** Three concrete examples, because "describe a subproject" is not a prompt anyone
 *  answers cold. Each names a job, the apps it touches, and a cadence — the
 *  three things the agent asks for if you leave them out. */
const EXAMPLES = [
  'Every Monday, read last week’s Sentry errors and open a Linear issue for anything new, grouped by root cause.',
  'Each morning, check Search Console for pages that lost impressions and post a short digest to Slack.',
  'When a dependency has a new major release, open a PR that upgrades it and summarise the breaking changes.',
];

/**
 * "Grow your subprojects" — describe a subproject and have one built.
 *
 * A textarea and a button, because that IS the interface: the agent asks its own
 * follow-up questions inside the session, so a form with fields for agent, cron
 * and connectors would be asking the person to do the design work they came here
 * to delegate.
 *
 * Submitting starts a real session and navigates to it. It never claims a subproject
 * was created — nothing exists when the call resolves except the session.
 */
export function AuthorSubprojectModal({
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
  const { author } = useProjectSubprojects(projectId);
  const [description, setDescription] = useState('');

  const trimmed = description.trim();
  const tooLong = trimmed.length > MAX_DESCRIPTION;
  const ready = trimmed.length > 0 && !tooLong;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || author.isPending) return;
    try {
      const result = await author.mutateAsync(trimmed);
      const href = prepareInstallSessionNavigation(
        queryClient,
        router,
        projectId,
        result.session_id,
      );
      onOpenChange(false);
      setDescription('');
      if (href) router.push(href);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Could not start the authoring session');
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setDescription('');
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-lg" aria-label="Grow a subproject">
        <ModalHeader>
          <ModalTitle>Grow a subproject</ModalTitle>
          <ModalDescription>
            Say what the job is. Kortix creates the repository, writes the agent and its triggers,
            validates it, and publishes it to your subprojects.
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody className="space-y-4">
            <Field>
              <FieldLabel htmlFor="subproject-description">What should it do?</FieldLabel>
              <Textarea
                id="subproject-description"
                rows={5}
                variant="outline"
                placeholder="Every Monday, read last week's Sentry errors and open a Linear issue for anything new."
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                aria-invalid={tooLong || undefined}
                autoFocus
              />
              {tooLong ? (
                <FieldDescription className="text-kortix-red tabular-nums">
                  {trimmed.length} / {MAX_DESCRIPTION} characters — trim it down.
                </FieldDescription>
              ) : (
                <FieldDescription>
                  Name the job, the apps it touches, and how often it runs. The agent asks about
                  anything you leave out.
                </FieldDescription>
              )}
            </Field>

            {/* Filling the field for them beats explaining what to type. */}
            {trimmed.length === 0 ? (
              <div className="space-y-1.5">
                <p className="text-muted-foreground text-xs font-medium">
                  Or start from one of these
                </p>
                <ul className="space-y-1.5">
                  {EXAMPLES.map((example) => (
                    <li key={example}>
                      <button
                        type="button"
                        onClick={() => setDescription(example)}
                        className="bg-popover hover:border-foreground/20 text-muted-foreground hover:text-foreground duration-normal w-full cursor-pointer rounded-md border px-3 py-2 text-left text-xs leading-relaxed text-pretty transition-colors active:scale-[0.99]"
                      >
                        {example}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || author.isPending}>
              {author.isPending ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <SparkleIcon className="size-4 shrink-0" aria-hidden />
              )}
              {author.isPending ? 'Starting' : 'Build it'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
