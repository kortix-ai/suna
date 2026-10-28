'use client';

import { TelegramChatMock } from './channel-mocks';

/**
 * Telegram as a channel row: connect a bot
 * by its BotFather token, pick who may talk to it, disconnect. The token goes
 * to the API once and never comes back to the browser. The allowed users
 * dialog is `TelegramUsersPanel`.
 */
import { Button } from '../../../primitives/button';
import { CountBadge } from '../../../primitives/count-badge';
import { Field, FieldDescription, FieldGroup, FieldTitle } from '../../../primitives/field';
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
import { errorToast, successToast } from '../../../primitives/toast';
import {
  ChannelDisconnectButton,
  ChannelRow,
} from './channel-row';
import { TelegramUsersPanel } from './telegram-users-panel';
import {
  useConnectTelegram,
  useDisconnectTelegram,
  useTelegramInstall,
} from '../../../internal/hooks/channels/use-channels-installations';
import { useTranslations } from '../../../i18n';
import { useState } from 'react';

/** "1, 2 3" → ["1","2","3"]; null when any entry is not a number. */
export function parseTelegramUserIds(raw: string): string[] | null {
  const ids = raw.split(/[\s,]+/).filter(Boolean);
  return ids.every((id) => /^\d{1,20}$/.test(id)) ? ids : null;
}

export function TelegramChannelRow({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const tPages = useTranslations('connectorPages');
  const { data: install } = useTelegramInstall(projectId);
  const disconnect = useDisconnectTelegram();
  const [dialog, setDialog] = useState<'connect' | 'users' | null>(null);

  return (
    <>
      <ChannelRow
        app="telegram"
        name="Telegram"
        connected={Boolean(install)}
        detail={install?.username ? `@${install.username}` : null}
        hero={{
          title: tPages('telegramHeroTitle'),
          connectedTitle: tPages('channelConnectedTitle', { name: 'Telegram' }),
          ...(install ? {} : { lede: tPages('telegramHeroLede') }),
          preview: <TelegramChatMock />,
        }}
        pitch={t.raw('text51e6bc656528')}
        actions={
          !canWrite ? null : install ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setDialog('users')}>
                {t.raw('text2c3059c25723')}
                {install.access_request_count ? (
                  <CountBadge count={install.access_request_count} tone="waiting" />
                ) : null}
              </Button>
              <ChannelDisconnectButton
                pending={disconnect.isPending}
                onConfirm={(done) =>
                  disconnect.mutate(projectId, {
                    onSuccess: () => {
                      done();
                      successToast(t.raw('textdfea5351a743'));
                    },
                    onError: (error) => errorToast(error.message),
                  })
                }
              />
            </>
          ) : (
            <Button className="transition-transform active:scale-96" onClick={() => setDialog('connect')}>
              {t.raw('text1a2303ede074')}
            </Button>
          )
        }
      />
      <Modal open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <ModalContent>
          {dialog === 'connect' ? (
            <TelegramConnectForm projectId={projectId} onDone={() => setDialog(null)} />
          ) : dialog === 'users' ? (
            <TelegramUsersPanel projectId={projectId} onDone={() => setDialog(null)} />
          ) : null}
        </ModalContent>
      </Modal>
    </>
  );
}

function TelegramConnectForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const connect = useConnectTelegram();
  const [token, setToken] = useState('');
  const [users, setUsers] = useState('');
  const ids = parseTelegramUserIds(users);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ids) return;
        connect.mutate(
          { projectId, bot_token: token.trim(), allowed_user_ids: ids },
          {
            onSuccess: () => {
              successToast(t.raw('text815464994ec4'));
              onDone();
            },
            onError: (error) => errorToast(error.message),
          },
        );
      }}
    >
      <ModalHeader>
        <ModalTitle>{t.raw('text00c7991f0490')}</ModalTitle>
        <ModalDescription>{t.raw('texta832efd235a7')}</ModalDescription>
      </ModalHeader>
      <ModalBody>
        <FieldGroup>
          <Field>
            <FieldTitle>{t.raw('text5bb9aecca021')}</FieldTitle>
            <Input
              type="password"
              autoComplete="off"
              placeholder="123456789:…"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
          <TelegramUsersField value={users} onChange={setUsers} invalid={!ids} />
        </FieldGroup>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t.raw('text19766ed6ccb2')}
        </Button>
        <Button type="submit" disabled={!token.trim() || !ids || connect.isPending}>
          {connect.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {t.raw('text1a2303ede074')}
        </Button>
      </ModalFooter>
    </form>
  );
}

function TelegramUsersField({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Field>
      <FieldTitle>{t.raw('text71552d197b53')}</FieldTitle>
      <Input
        inputMode="numeric"
        placeholder="123456789, 987654321"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid}
      />
      <FieldDescription>{invalid ? t.raw('text50fcd9c3c020') : t.raw('text1f7a451d4722')}</FieldDescription>
    </Field>
  );
}
