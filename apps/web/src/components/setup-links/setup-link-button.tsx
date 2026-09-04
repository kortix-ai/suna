'use client';

import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { OutcomeCard } from '@/features/session/outcomes/outcome-card';
import type { Outcome } from '@/features/session/outcomes/outcome-types';
import { outcomeTint } from '@/features/session/outcomes/outcome-vocabulary';
import { cn } from '@/lib/utils';
import { KeyIcon, PlugIcon } from '@phosphor-icons/react';
import React, { useCallback, useMemo, useState } from 'react';
import { ConnectorIntake } from './connector-intake';
import { SecretIntakeForm } from './secret-intake-form';
import { onSetupLinkModalClose } from './setup-link-close-finalize';
import { setupLinkChipLabel, type SetupLinkKind } from './util';

const COPY = {
  secret: {
    icon: KeyIcon,
    action: 'Add secret',
    fallback: 'Enter credentials',
    title: 'Add a project secret',
    blurb: 'Stored encrypted. The agent can use it but never sees the value.',
    /** Shown once the value has been submitted from this card. */
    doneStatus: 'Added',
  },
  connector: {
    icon: PlugIcon,
    action: 'Connect',
    fallback: 'Connect app',
    title: 'Connect an app',
    blurb: 'You authorize directly with the provider. No keys reach the chat or the repo.',
    doneStatus: 'Connected',
  },
} as const satisfies Record<SetupLinkKind, unknown>;

/** The tile treatment, shared by the card and the modal header so they cannot drift. */
const TILE = 'flex size-9 shrink-0 items-center justify-center rounded-sm ring-1';

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * In-chat renderer for an agent-minted setup link: the session's `OutcomeCard`,
 * opening a modal with the fill-in form (secret) or the 1-click connect
 * (connector). Used by the markdown link interceptor.
 *
 * `warning` tone throughout — the same one the transcript uses for "waiting for
 * you", which is what a setup link is: the turn cannot finish until you act.
 */
export function SetupLinkButton({
  kind,
  token,
  children,
}: {
  kind: SetupLinkKind;
  token: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  /**
   * Settled from THIS card, in this page's lifetime.
   *
   * Deliberately not fetched. Neither setup-link GET reports whether the work
   * is already done — `ConnectorSetupLinkInfo` is
   * `{project_name, slug, app, expires_at}` and `SecretSetupLinkInfo` is
   * `{project_name, fields, expires_at}` (`platform-client/host-boundary.ts`).
   * The only "is it connected" answer is `POST …/finalize`, which also persists
   * and notifies, so asking it on mount for every card in a transcript would be
   * a write on render against a rate-limited route.
   *
   * The consequence, stated plainly: after a reload the card reads "Waiting for
   * you" again even when the app is connected. Closing that needs a field on
   * the GET response, which is an API change.
   */
  const [settled, setSettled] = useState(false);
  const copy = COPY[kind];
  const Icon = copy.icon;
  const tint = outcomeTint(settled ? 'success' : 'warning');
  const label = setupLinkChipLabel(textOf(children), token, copy.fallback);

  /** Stable so `ConnectorIntake`'s notify effect does not refire on every render. */
  const handleSettled = useCallback((): void => setSettled(true), []);

  /** Closing settles the connect; the rule lives in `onSetupLinkModalClose` so it is testable. */
  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    void onSetupLinkModalClose({ open: next, kind, token });
  };

  // `kind: 'external'` is the closest of the three the union offers, and only
  // decides the testid — the glyph comes from the `icon` override.
  //
  // Settled, the row stops being a call to action and becomes a record, exactly
  // like a merged change request in the transcript: green tone, past-tense
  // status, and a quiet outline button that reopens the same modal to look
  // rather than to act.
  const outcome = useMemo<Outcome>(
    () => ({
      id: `setup:${token}`,
      kind: 'external',
      title: label,
      description: '',
      status: settled
        ? { label: copy.doneStatus, tone: 'success' }
        : { label: 'Waiting for you', tone: 'warning' },
      at: 0,
      meta: [],
      action: { label: settled ? 'View' : copy.action, intent: 'open' },
      resourceHref: null,
    }),
    [token, label, copy.action, copy.doneStatus, settled],
  );

  return (
    <>
      <OutcomeCard
        outcome={outcome}
        index={0}
        icon={Icon}
        // Filled only while it blocks the turn. Once settled it is a record,
        // and a filled button on a record is a call to action with nothing to
        // call for.
        actionVariant={settled ? 'outline' : 'default'}
        onOpen={() => setOpen(true)}
        className="my-2"
      />

      <Modal open={open} onOpenChange={handleOpenChange}>
        <ModalContent className="lg:max-w-md">
          {/* The card's tile repeats here so the open reads as continuous. */}
          <ModalHeader className="flex-row items-center gap-3">
            <span className={cn(TILE, tint.ring, tint.bg)}>
              <Icon weight="fill" className={cn('size-5', tint.fg)} />
            </span>
            <div className="min-w-0 flex-1">
              <ModalTitle>{copy.title}</ModalTitle>
              <ModalDescription>{copy.blurb}</ModalDescription>
            </div>
          </ModalHeader>

          <ModalBody className="max-h-[60vh] overflow-y-auto">
            {kind === 'secret' ? (
              <SecretIntakeForm token={token} compact onDone={handleSettled} />
            ) : (
              <ConnectorIntake token={token} compact onConnected={handleSettled} />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
