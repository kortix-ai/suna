'use client';

import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { CheckIcon, WarningIcon } from '@phosphor-icons/react';
import { useEffect } from 'react';

import { ConnectorHandshake } from './connector-handshake';
import { useConnectorIntake } from './connector-intake';
import { connectorHeadline } from './connector-link-info';

const COPY = {
  title: 'Connect {app}',
  titleToProject: 'Connect {app} to {project}',
  connectedTitle: '{app} connected',
  description: 'You sign in on {app} in a new window. Kortix never sees your password.',
  connectedDescription: 'The agent can use {app} now and continues on its own.',
  waiting: 'Finish signing in to {app} in the window that opened.',
  connectedAs: 'Connected as {account}',
  loading: 'Loading…',
  cancel: 'Cancel',
  close: 'Close',
  done: 'Done',
  connect: 'Connect {app}',
  opening: 'Opening…',
  reopen: 'Reopen window',
  fallbackApp: 'the app',
} as const;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

/**
 * The in-chat connect dialog: Kortix · · · App at the head, one plain sentence
 * of what happens, and the actions bottom right.
 *
 * The flow itself (load, open the provider window, poll, finalize) is
 * `useConnectorIntake`, the same one the public `/connect/[token]` page runs.
 * This file is only the dialog around it.
 *
 * Mobile: `Modal` is a bottom sheet below `lg`, and the footer stacks its two
 * buttons full width with the primary action on top (`ModalFooter` is
 * `flex-col-reverse` until `sm`).
 */
export function ConnectorConnectModal({
  token,
  open,
  onOpenChange,
  onConnected,
  fallbackName,
}: {
  token: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
  /** The app the card already names, shown until the link info loads. */
  fallbackName: string;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        {/* Mounted only while open: the GET and the poll run for an open dialog, not every card. */}
        {open ? (
          <ConnectDialogBody
            token={token}
            onClose={() => onOpenChange(false)}
            onConnected={onConnected}
            fallbackName={fallbackName}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function ConnectDialogBody({
  token,
  onClose,
  onConnected,
  fallbackName,
}: {
  token: string;
  onClose: () => void;
  onConnected: () => void;
  fallbackName: string;
}) {
  const copy = useLocalizedUiCatalog(COPY);
  const { phase, info, error, connectedAs, connect } = useConnectorIntake(token);

  useEffect(() => {
    if (phase === 'connected') onConnected();
  }, [phase, onConnected]);

  const headline = info ? connectorHeadline(info) : null;
  const app = headline?.app ?? (fallbackName || copy.fallbackApp);
  const connected = phase === 'connected';
  const starting = phase === 'starting';
  const waiting = phase === 'opened';

  const title = connected
    ? fill(copy.connectedTitle, { app })
    : headline?.project
      ? fill(copy.titleToProject, { app, project: headline.project })
      : fill(copy.title, { app });
  const description = fill(connected ? copy.connectedDescription : copy.description, { app });

  // A state row only when there is a state to report; the ready dialog is band,
  // title, sentence, actions.
  const status =
    phase === 'loading' ? (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loading variant="spokes" className="size-4 shrink-0" />
        {copy.loading}
      </p>
    ) : phase === 'error' || error ? (
      <InfoBanner tone="destructive" icon={<WarningIcon weight="fill" />} title={error ?? ''} />
    ) : waiting ? (
      <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
        <Loading variant="spokes" className="size-4 shrink-0" />
        <p className="text-sm text-pretty">{fill(copy.waiting, { app })}</p>
      </div>
    ) : connected && connectedAs ? (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <CheckIcon weight="bold" className="text-kortix-green size-4 shrink-0" />
        <span className="min-w-0 truncate" data-testid="connector-intake-connected-as">
          {fill(copy.connectedAs, { account: connectedAs })}
        </span>
      </p>
    ) : null;

  return (
    <>
      {/*
        The band: the pair on a flush strip above a hairline, like an app-store
        sheet (Paper, "Connect modal · variants" B). `bg-background` is a step
        off the dialog's `bg-sidebar` in both themes, so the strip reads as its
        own surface without a shadow. The modal's close button sits over it.
      */}
      <div className="bg-background border-border flex aspect-[21/9] shrink-0 items-center justify-center border-b">
        <ConnectorHandshake
          name={app}
          iconUrl={phase === 'loading' ? undefined : (info?.icon_url ?? null)}
          connected={connected}
          size="xl"
          collapsible={false}
        />
      </div>

      {/* `pr-12` keeps a long title clear of the close button on narrow sheets. */}
      <ModalHeader className="gap-1 pt-0 pr-12">
        <ModalTitle>{title}</ModalTitle>
        <ModalDescription className="text-pretty">{description}</ModalDescription>
      </ModalHeader>

      {status ? <ModalBody>{status}</ModalBody> : null}

      <ModalFooter>
        {connected ? (
          <Button className="w-full sm:w-auto" onClick={onClose}>
            {copy.done}
          </Button>
        ) : (
          <>
            <Button variant="outline-ghost" className="w-full sm:w-auto" onClick={onClose}>
              {waiting ? copy.close : copy.cancel}
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={connect}
              disabled={starting || phase === 'loading' || phase === 'error'}
            >
              {starting ? <SessionDotMatrix className="size-4 shrink-0" /> : null}
              {starting ? copy.opening : waiting ? copy.reopen : fill(copy.connect, { app })}
            </Button>
          </>
        )}
      </ModalFooter>
    </>
  );
}
