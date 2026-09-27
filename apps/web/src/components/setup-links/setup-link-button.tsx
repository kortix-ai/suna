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
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CheckIcon, KeyIcon, PlugIcon } from '@phosphor-icons/react';
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ConnectorAppMark, ConnectorHandshake } from './connector-handshake';
import { ConnectorConnectModal } from './connector-connect-modal';
import { connectorHeadline, useConnectorLinkInfo } from './connector-link-info';
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

/** Card and modal titles once the link says which app, and for which project. */
const CONNECTOR_TITLES = {
  app: 'Connect {app}',
  appToProject: 'Connect {app} to {project}',
} as const;

/**
 * True inside a table cell or a list item. A setup link there shares its line
 * with other content (see `components/markdown/setup-link-blocks.ts`, which
 * lifts the links that do not), so it renders as an inline chip, not a card.
 */
export const SetupLinkInlineContext = createContext(false);

/** "Connect HubSpot" → "HubSpot": the app a link's own text names, if any. */
function appFromLabel(label: string): string {
  return label.replace(/^connect\s+/i, '').trim() || label;
}

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
  /**
   * `null` while the link's URL is still streaming (`holdPendingSetupLink`).
   * The card then reads "Preparing link…" with its action disabled and no
   * modal, and turns live in place once the token has arrived.
   */
  token: string | null;
  children?: React.ReactNode;
}): React.ReactElement {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
  const inline = useContext(SetupLinkInlineContext);
  const localizedCopy = useLocalizedUiCatalog(COPY);
  const titles = useLocalizedUiCatalog(CONNECTOR_TITLES);
  const copy = localizedCopy[kind];
  const Icon = copy.icon;
  const pending = token === null;
  const agentLabel = setupLinkChipLabel(textOf(children), token ?? '', copy.fallback);

  // The link names its app and project; the agent's own text does not always
  // ("Connect", or a bare URL). Until the GET answers, the agent's label stands.
  const info = useConnectorLinkInfo(kind === 'connector' ? token : null);
  const headline = info ? connectorHeadline(info) : null;
  const headlineApp = headline?.app ?? null;
  const headlineProject = headline?.project ?? null;
  const appName = headlineApp ?? appFromLabel(agentLabel);
  const label =
    headlineApp === null
      ? agentLabel
      : (headlineProject ? titles.appToProject : titles.app)
          .replace('{app}', headlineApp)
          .replace('{project}', headlineProject ?? '');
  // `undefined` while the info loads (skeleton), `null` once known to have none.
  const iconUrl = info === undefined ? undefined : (info?.icon_url ?? null);

  /** Stable so `ConnectorIntake`'s notify effect does not refire on every render. */
  const handleSettled = useCallback((): void => setSettled(true), []);

  /** Closing settles the connect; the rule lives in `onSetupLinkModalClose` so it is testable. */
  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (token !== null) void onSetupLinkModalClose({ open: next, kind, token });
  };

  // `kind: 'external'` is the closest of the three the union offers, and only
  // decides the testid — the glyph comes from the `icon` override.
  //
  // Settled, the row stops being a call to action and becomes a record, exactly
  // like a merged change request in the transcript: green tone, past-tense
  // status, and a quiet outline button that reopens the same modal to look
  // rather than to act.
  //
  // Pending keeps the live card's tone, title, and action label, so the only
  // change when the token lands is the status line and the button enabling.
  const outcome = useMemo<Outcome>(
    () => ({
      id: `setup:${token ?? 'pending'}`,
      kind: 'external',
      title: label,
      description: '',
      status: settled
        ? { label: copy.doneStatus, tone: 'success' }
        : {
            label: tI18nComplete.raw(pending ? 'textae47d51077b4' : 'text9f760ab20739'),
            tone: 'warning',
          },
      at: 0,
      meta: [],
      action: { label: settled ? 'View' : copy.action, intent: 'open' },
      resourceHref: null,
    }),
    [token, pending, label, settled, copy.doneStatus, copy.action, tI18nComplete],
  );

  const card = inline ? (
    <button
      type="button"
      data-testid={`setup-link-chip-${kind}`}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() => setOpen(true)}
      className={cn(
        'border-border bg-muted/50 text-foreground hover:bg-hover inline-flex max-w-full items-center gap-1.5',
        'rounded-md border py-0.5 pr-2 pl-0.5 align-middle text-sm font-medium',
        'transition-colors active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      {kind === 'connector' ? (
        <ConnectorAppMark name={appName} iconUrl={iconUrl} size="xs" />
      ) : (
        <span className="bg-kortix-orange/15 flex size-5 shrink-0 items-center justify-center rounded-sm">
          <Icon weight="fill" className="text-kortix-orange size-3" />
        </span>
      )}
      <span className="truncate">{label}</span>
      {settled ? (
        <CheckIcon weight="bold" className="text-kortix-green size-3.5 shrink-0" />
      ) : (
        <span className="bg-kortix-orange size-1.5 shrink-0 rounded-full" />
      )}
    </button>
  ) : (
    <OutcomeCard
      outcome={outcome}
      index={0}
      icon={Icon}
      media={
        kind === 'connector' ? (
          <ConnectorHandshake name={appName} iconUrl={iconUrl} connected={settled} />
        ) : undefined
      }
      actionVariant={settled ? 'outline' : 'default'}
      pending={pending}
      onOpen={() => setOpen(true)}
      // The query container for `ConnectorHandshake`'s narrow layout. Below
      // 28rem the title wraps to two lines instead of cutting off the app name.
      titleClassName="@max-md/connect:line-clamp-2 @max-md/connect:whitespace-normal"
      className="@container/connect my-2"
    />
  );

  return (
    <>
      {card}

      {token !== null && kind === 'connector' ? (
        <ConnectorConnectModal
          token={token}
          open={open}
          onOpenChange={handleOpenChange}
          onConnected={handleSettled}
          fallbackName={appName}
        />
      ) : null}

      {token !== null && kind === 'secret' ? (
        <Modal open={open} onOpenChange={handleOpenChange}>
          <ModalContent className="lg:max-w-lg">
            {/* `pr-12` keeps the text clear of the absolute close button (`top-3 right-3 size-8`). */}
            <ModalHeader className="pr-12">
              <ModalTitle>{copy.title}</ModalTitle>
              <ModalDescription className="text-pretty">{copy.blurb}</ModalDescription>
            </ModalHeader>

            <ModalBody className="max-h-[60vh] overflow-y-auto">
              <SecretIntakeForm token={token} compact onDone={handleSettled} />
            </ModalBody>
          </ModalContent>
        </Modal>
      ) : null}
    </>
  );
}
