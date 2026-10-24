'use client';

/**
 * Email inboxes as ACCOUNTS on the `kortix_email` connector profile. One
 * profile, many inboxes: each Resend inbox is an account with a name, an owner
 * (you only, or shared) and a default, like every other connector's accounts.
 * What only email adds lives here: the "Add inbox" dialog (the standard
 * account fields, then where the inbox lives and its address), who may email
 * an inbox, and the Email hero that counts the inboxes.
 */

import { CaretRightIcon } from '@phosphor-icons/react';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { grantConnectionAccess } from '../../../access/access/access-dialog-share';
import { useTranslations } from '../../../i18n';
import {
  type EmailInbox,
  useEmailInboxes,
  useUpdateEmailInbox,
} from '../../../internal/hooks/channels/use-email-inboxes';
import type { EmailSenderPolicy } from '../../../internal/hooks/channels/use-channels-installations';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCan } from '../../../internal/lib/use-project-can';
import { Button } from '../../../primitives/button';
import { Checkbox } from '../../../primitives/checkbox';
import { Field } from '../../../primitives/field';
import { InfoBanner } from '../../../primitives/info-banner';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
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
import { errorToast, successToast } from '../../../primitives/toast';
import { UiLink as Link } from '../../../providers/ui-provider';
import { AddAccountFields } from '../../sections/add-account-fields';
import { ChannelHeroFrame, ChannelHeroStatus } from '../../sections/component/channel-hero-frame';
import { EmailThreadMock } from '../../sections/component/channel-mocks';
import { EmailConnectForm } from '../../sections/component/email-connect-form';
import {
  newAccountGrantees,
  newAccountLabelTaken,
  type NewAccountDraft,
} from '../../sections/view/connector-connections';
import { proposeAccountLabel } from '../install/install';
import { connectorHref } from '../connector-routes';

/** The one connector profile every inbox is an account on. */
export const EMAIL_CONNECTOR_SLUG = 'kortix_email';

/** "Kortix managed" or "Your Resend account": where an inbox lives. */
export function EmailInboxHome({ inbox }: { inbox: Pick<EmailInbox, 'managed'> }) {
  const t = useTranslations('emailInboxes');
  return <span>{inbox.managed ? t('homeManaged') : t('homeOwn')}</span>;
}

/** The sender policy in the editor's shape, whatever casing the wire used. */
export function inboxSenderPolicy(inbox: Pick<EmailInbox, 'sender_policy'> | null | undefined): EmailSenderPolicy {
  const raw = (inbox?.sender_policy ?? {}) as Record<string, unknown>;
  const list = (camel: string, snake: string) => {
    const value = raw[camel] ?? raw[snake];
    return Array.isArray(value) ? value.map(String) : [];
  };
  const regex = raw.allowedRegex ?? raw.allowed_regex;
  return {
    mode: raw.mode === 'restricted' ? 'restricted' : 'allow_all',
    allowedEmails: list('allowedEmails', 'allowed_emails'),
    allowedDomains: list('allowedDomains', 'allowed_domains'),
    allowedRegex: typeof regex === 'string' && regex ? regex : null,
  };
}

/** What the account half of "Add inbox" needs: may the viewer share, and "Everyone in {project}". */
function useInboxAccountAccess(projectId: string) {
  const tSharing = useTranslations('accessSharing');
  const accountId = useProjectAccountId(projectId);
  const canManageConnections =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, { accountId }).allowed === true;
  const projectQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = projectQuery.data?.project?.name ?? '';
  const everyoneLabel = projectName ? tSharing('everyone', { project: projectName }) : tSharing('visibilityEveryone');
  return { accountId, canManageConnections, everyoneLabel };
}

const EMPTY_DRAFT: NewAccountDraft = { label: '', audience: 'project', picked: { memberIds: [], groupIds: [] } };

/**
 * "Add inbox": the account's name and who can use it (`AddAccountFields`, the
 * same fields every connector's Add account asks), then the inbox itself
 * (`EmailConnectForm`). Picked people get the account shared with them after
 * it exists, exactly like `useAddAccount`.
 */
export function AddEmailInboxDialog({
  projectId,
  open,
  onOpenChange,
  existing,
  onAdded,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The profile's accounts, for a free name and the "already used" check. */
  existing: ReadonlyArray<{ label: string; owner_type: string }>;
  onAdded: (inbox: EmailInbox) => void;
}) {
  const t = useTranslations('emailInboxes');
  const { accountId, canManageConnections, everyoneLabel } = useInboxAccountAccess(projectId);
  const [draft, setDraft] = useState<NewAccountDraft>(EMPTY_DRAFT);
  const [opened, setOpened] = useState(false);
  // Each opening starts from a free name; a shared account needs the right to share.
  if (open && !opened) {
    setOpened(true);
    setDraft({
      ...EMPTY_DRAFT,
      audience: canManageConnections ? 'project' : 'private',
      label: proposeAccountLabel(t('defaultLabel'), existing.map((row) => row.label)),
    });
  }
  if (!open && opened) setOpened(false);

  const labelTaken = newAccountLabelTaken(draft, existing);
  const share = draft.audience === 'private' ? 'me' : 'project';
  const ready =
    draft.label.trim().length > 0 &&
    !labelTaken &&
    (draft.audience !== 'members' || draft.picked.memberIds.length + draft.picked.groupIds.length > 0);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>{t('addTitle')}</ModalTitle>
          <ModalDescription>{t('addDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[75vh] space-y-6 overflow-y-auto">
          <section className="space-y-4">
            <AddAccountFields
              projectId={projectId}
              value={draft}
              onChange={setDraft}
              labelTaken={labelTaken}
              canManageConnections={canManageConnections}
              accountId={accountId}
              everyoneLabel={everyoneLabel}
              hint={t('labelHint')}
              autoFocus
            />
          </section>
          {ready ? (
            <EmailConnectForm
              projectId={projectId}
              account={{ label: draft.label, share }}
              onConnected={async (inbox) => {
                if (draft.audience === 'members' && accountId) {
                  await grantConnectionAccess(
                    accountId,
                    projectId,
                    inbox.connection_id,
                    newAccountGrantees(draft.picked),
                  ).catch((e: Error) => errorToast(e.message));
                }
                successToast(t('added', { address: inbox.email }));
                onAdded(inbox);
                onOpenChange(false);
              }}
            />
          ) : (
            <p className="text-muted-foreground text-sm">{t('nameFirst')}</p>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function splitPolicyList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

/** "Who can email" for one inbox: anyone, or only the listed senders. */
export function EmailSenderPolicyDialog({
  projectId,
  inbox,
  open,
  onOpenChange,
}: {
  projectId: string;
  inbox: EmailInbox | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('emailInboxes');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const update = useUpdateEmailInbox();
  const initial = inboxSenderPolicy(inbox);
  const [restricted, setRestricted] = useState(initial.mode === 'restricted');
  const [emails, setEmails] = useState(initial.allowedEmails.join('\n'));
  const [domains, setDomains] = useState(initial.allowedDomains.join('\n'));
  const [regex, setRegex] = useState(initial.allowedRegex ?? '');
  const [error, setError] = useState<string | null>(null);
  // Each inbox opened starts from its own saved policy.
  const [syncedId, setSyncedId] = useState<string | null>(null);
  if (inbox && open && inbox.connection_id !== syncedId) {
    setSyncedId(inbox.connection_id);
    setRestricted(initial.mode === 'restricted');
    setEmails(initial.allowedEmails.join('\n'));
    setDomains(initial.allowedDomains.join('\n'));
    setRegex(initial.allowedRegex ?? '');
    setError(null);
  }
  if (!open && syncedId) setSyncedId(null);

  const save = () => {
    if (!inbox) return;
    setError(null);
    const sender_policy: EmailSenderPolicy = {
      mode: restricted ? 'restricted' : 'allow_all',
      allowedEmails: splitPolicyList(emails),
      allowedDomains: splitPolicyList(domains).map((domain) => domain.replace(/^@+/, '')),
      allowedRegex: regex.trim() || null,
    };
    if (sender_policy.allowedRegex) {
      try {
        new RegExp(sender_policy.allowedRegex);
      } catch {
        setError(t('regexInvalid'));
        return;
      }
    }
    update.mutate(
      { projectId, connectionId: inbox.connection_id, sender_policy },
      {
        onSuccess: () => {
          successToast(t('policySaved'));
          onOpenChange(false);
        },
        onError: (e) => setError((e as Error).message),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={(next) => !update.isPending && onOpenChange(next)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('policyTitle', { address: inbox?.email ?? '' })}</ModalTitle>
          <ModalDescription>{t('policyDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <div className="flex items-start gap-3">
            <Checkbox
              id="email-inbox-restricted"
              checked={restricted}
              onCheckedChange={(checked) => setRestricted(Boolean(checked))}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <Label htmlFor="email-inbox-restricted">{tI18nComplete.raw('texta48c89f63885')}</Label>
                <p className="text-muted-foreground mt-1 text-xs">{tI18nComplete.raw('text8c67b476d59b')}</p>
              </div>
              {restricted ? (
                <div className="grid gap-3">
                  <Field>
                    <Input
                      value={emails}
                      onChange={(e) => setEmails(e.target.value)}
                      placeholder={tI18nComplete.raw('text542d24012988')}
                    />
                  </Field>
                  <Field>
                    <Input
                      value={domains}
                      onChange={(e) => setDomains(e.target.value)}
                      placeholder={tI18nComplete.raw('texta379a6f6eeaf')}
                    />
                  </Field>
                  <Field>
                    <Input
                      value={regex}
                      onChange={(e) => setRegex(e.target.value)}
                      placeholder={tI18nComplete.raw('text8b21058f3253')}
                      spellCheck={false}
                    />
                  </Field>
                </div>
              ) : null}
              {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
            </div>
          </div>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button variant="outline-ghost" onClick={() => onOpenChange(false)} disabled={update.isPending}>
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {tI18nComplete.raw('text1509f561f241')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/**
 * The Email hero (Channels tab, the Email page): the pitch until a first inbox
 * exists, then how many inboxes there are, their addresses, and Manage (the
 * connector page with the account list) or Add another inbox. Like ComputerHero.
 */
export function EmailHero({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const t = useTranslations('emailInboxes');
  const tPages = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const inboxes = useEmailInboxes(projectId);
  const [addOpen, setAddOpen] = useState(false);
  const list = inboxes.data ?? [];
  const connected = list.length > 0;
  const addresses = list.map((inbox) => inbox.email).join(', ');

  return (
    <>
      <ChannelHeroFrame
        app="email"
        title={connected ? t('heroCount', { count: list.length }) : tPages('emailHeroTitle')}
        lede={tPages('emailHeroLede')}
        status={
          connected ? (
            <ChannelHeroStatus label={tI18nComplete.raw('text22965568d22a')} detail={addresses || null} />
          ) : undefined
        }
        actions={
          connected ? (
            <>
              <Button size="sm" asChild>
                <Link href={connectorHref(projectId, EMAIL_CONNECTOR_SLUG)}>
                  {t('heroManage')}
                  <CaretRightIcon className="size-3.5 shrink-0" />
                </Link>
              </Button>
              {canWrite ? (
                <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
                  {t('heroAddAnother')}
                </Button>
              ) : null}
            </>
          ) : canWrite ? (
            <Button className="transition-transform active:scale-96" onClick={() => setAddOpen(true)}>
              {t('heroAdd')}
            </Button>
          ) : null
        }
        preview={<EmailThreadMock />}
      />
      <AddEmailInboxDialog
        projectId={projectId}
        open={addOpen}
        onOpenChange={setAddOpen}
        existing={list.map((inbox) => ({ label: inbox.label, owner_type: inbox.owner_type }))}
        onAdded={() => void inboxes.refetch()}
      />
    </>
  );
}
