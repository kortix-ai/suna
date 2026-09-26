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
import { AddAccountFields } from '@/features/workspace/customize/sections/add-account-fields';
import {
  connectorConnectionRows,
  newAccountAudienceFor,
  newAccountLabelTaken,
  newAccountReady,
  type NewAccountDraft,
} from '@/features/workspace/customize/sections/view/connector-connections';
import { useAddManagedAccount } from '@/hooks/connectors/use-add-managed-account';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
import { useProjectCan } from '@/lib/use-project-can';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import {
  finalizeConnectorSetupLink,
  listConnections,
  type ConnectorSetupLinkInfo,
} from '@kortix/sdk';
import { useProjectAccountId } from '@kortix/sdk/react';
import { CheckIcon, WarningIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { ConnectorHandshake } from './connector-handshake';
import { useConnectorIntake } from './connector-intake';
import { connectorHeadline, useConnectorLinkInfo } from './connector-link-info';
import { setupLinkApiBase } from './util';

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
 * The in-chat connect dialog: Kortix · · · App at the head, then the same Add
 * account form as Customize → Connectors — a name and who can use the account
 * — and the actions bottom right.
 *
 * A connect link ADDS an account. The dialog creates a new named row through
 * the project's own routes (as the signed-in member), writes the audience
 * grants, runs the provider window for THAT row, then finalizes the link with
 * its connection id so the session that asked is told the account's name.
 * Before this, the link could only re-authorize a fixed slot account, so asking
 * for a second account from chat ended on "Already connected" to the first.
 *
 * A link whose info names no project (an older server) keeps the one-click
 * flow, `useConnectorIntake`, the one the public `/connect/[token]` page runs.
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

interface DialogBodyProps {
  token: string;
  onClose: () => void;
  onConnected: () => void;
  fallbackName: string;
}

function ConnectDialogBody(props: DialogBodyProps) {
  const info = useConnectorLinkInfo(props.token);
  return info?.project_id ? (
    <AddAccountDialogBody {...props} info={info} projectId={info.project_id} />
  ) : (
    <OneClickDialogBody {...props} />
  );
}

/** The link's connector gets a NEW named account, for the audience chosen here. */
function AddAccountDialogBody({
  token,
  info,
  projectId,
  onClose,
  onConnected,
  fallbackName,
}: DialogBodyProps & { info: ConnectorSetupLinkInfo; projectId: string }) {
  const copy = useLocalizedUiCatalog(COPY);
  const tSharing = useTranslations('accessSharing');
  const headline = connectorHeadline(info);
  const app = headline.app || fallbackName || copy.fallbackApp;
  const accountId = useProjectAccountId(projectId);
  const manage = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, {
    accountId,
  });
  const canManageConnections = manage.allowed === true;
  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
  });
  const rows = connectorConnectionRows(connectionsQuery.data?.connections, info.slug);
  const [draft, setDraft] = useState<NewAccountDraft>(() => ({
    label: info.label ?? '',
    audience: 'private',
    picked: { memberIds: [], groupIds: [] },
  }));
  // The agent's intended audience, preselected once we know the caller may share.
  const [audienceSeeded, setAudienceSeeded] = useState(false);
  if (!audienceSeeded && !manage.isLoading) {
    setAudienceSeeded(true);
    setDraft((prev) => ({ ...prev, audience: newAccountAudienceFor(info.owner, canManageConnections) }));
  }
  const [phase, setPhase] = useState<'form' | 'waiting' | 'connected'>('form');
  const [error, setError] = useState<string | null>(null);
  const [landed, setLanded] = useState<{ label: string; connectedAs: string | null } | null>(null);
  const managed = useAddManagedAccount(projectId, info.slug, accountId, () => undefined);

  const labelTaken = newAccountLabelTaken(draft, rows);
  const ready =
    phase === 'form' &&
    connectionsQuery.isSuccess &&
    newAccountReady(draft, rows, { canManageConnections, accountId });

  const submit = async () => {
    if (!ready) return;
    setError(null);
    setPhase('waiting');
    try {
      const { connectionId } = await managed.add(draft);
      if (!connectionId) throw new Error(tSharing('connectFailed'));
      // Names THIS account to the link, which tells the session that asked.
      const done = await finalizeConnectorSetupLink(
        token,
        { backendUrl: setupLinkApiBase() },
        { connectionId },
      );
      setLanded({ label: done.label ?? draft.label.trim(), connectedAs: done.connected_as ?? null });
      setPhase('connected');
      onConnected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tSharing('connectFailed'));
      setPhase('form');
    }
  };

  const connected = phase === 'connected';
  const waiting = phase === 'waiting';
  const audienceLabel =
    draft.audience === 'private'
      ? tSharing('onlyYou')
      : draft.audience === 'project'
        ? everyoneLabelFor(tSharing, headline.project)
        : tSharing('specificPeople');

  return (
    <>
      <div className="bg-background border-border flex aspect-[21/9] shrink-0 items-center justify-center border-b">
        <ConnectorHandshake
          name={app}
          iconUrl={info.icon_url ?? null}
          connected={connected}
          size="xl"
          collapsible={false}
        />
      </div>

      <ModalHeader className="gap-1 pt-0 pr-12">
        <ModalTitle>
          {connected
            ? fill(copy.connectedTitle, { app })
            : tSharing('addAccountTitle', { connector: app })}
        </ModalTitle>
        <ModalDescription className="text-pretty">
          {connected ? fill(copy.connectedDescription, { app }) : tSharing('addAccountDescription')}
        </ModalDescription>
      </ModalHeader>

      <ModalBody className="max-h-[50vh] space-y-4 overflow-y-auto">
        {error ? (
          <InfoBanner tone="destructive" icon={<WarningIcon weight="fill" />} title={error} />
        ) : null}
        {connected && landed ? (
          <div className="space-y-1.5" data-testid="connector-connect-landed">
            <p className="flex items-center gap-2 text-sm">
              <CheckIcon weight="bold" className="text-kortix-green size-4 shrink-0" />
              <span className="min-w-0 truncate">
                {tSharing('savedAs', { label: landed.label })} · {audienceLabel}
              </span>
            </p>
            {landed.connectedAs ? (
              <p className="text-muted-foreground pl-6 text-sm" data-testid="connector-intake-connected-as">
                {fill(copy.connectedAs, { account: landed.connectedAs })}
              </p>
            ) : null}
          </div>
        ) : waiting ? (
          <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
            <Loading variant="spokes" className="size-4 shrink-0" />
            <p className="text-sm text-pretty">{fill(copy.waiting, { app })}</p>
          </div>
        ) : (
          <AddAccountFields
            projectId={projectId}
            value={draft}
            onChange={setDraft}
            labelTaken={labelTaken}
            canManageConnections={canManageConnections}
            accountId={accountId}
            everyoneLabel={everyoneLabelFor(tSharing, headline.project)}
            hint={fill(copy.description, { app })}
            autoFocus={!info.label}
          />
        )}
      </ModalBody>

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
            <Button className="w-full sm:w-auto" onClick={() => void submit()} disabled={!ready}>
              {waiting ? <SessionDotMatrix className="size-4 shrink-0" /> : null}
              {waiting ? copy.opening : fill(copy.connect, { app })}
            </Button>
          </>
        )}
      </ModalFooter>
    </>
  );
}

function everyoneLabelFor(
  tSharing: ReturnType<typeof useTranslations>,
  project: string | null,
): string {
  return project ? tSharing('everyone', { project }) : tSharing('visibilityEveryone');
}

/** The one-click flow, for a link whose info names no project (an older server). */
function OneClickDialogBody({ token, onClose, onConnected, fallbackName }: DialogBodyProps) {
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
