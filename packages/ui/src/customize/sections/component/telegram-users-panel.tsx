'use client';

/**
 * Who may talk to a project's Telegram bot, as cards: the people who messaged
 * the bot and wait to be allowed, the allowed users, and an add-by-ID field.
 * Every action saves at once. The API adds or removes one id per call, so two
 * admins never overwrite each other's list.
 */
import { AccessRow, type AccessRowProps } from '../../../access/access/access-row';
import { Button } from '../../../primitives/button';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import { CountBadge } from '../../../primitives/count-badge';
import { EmptyArt } from '../../../primitives/empty-art';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import { Field, FieldDescription, FieldLabel } from '../../../primitives/field';
import { Input } from '../../../primitives/input';
import { ModalBody, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../../primitives/modal';
import { Skeleton } from '../../../primitives/skeleton';
import { errorToast } from '../../../primitives/toast';
import { UserAvatar } from '../../../primitives/user-avatar';
import {
  useAllowTelegramUser,
  useDismissTelegramAccessRequest,
  useRemoveTelegramUser,
  useTelegramUserPhoto,
  useTelegramUsers,
  type TelegramUser,
} from '../../../internal/hooks/channels/use-channels-installations';
import { useTranslations } from '../../../i18n';
import { UsersIcon } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState } from 'react';

/** First and last name, else @username, else the numeric id. */
export function telegramUserName(
  user: Pick<TelegramUser, 'user_id' | 'username' | 'first_name' | 'last_name'>,
): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || (user.username ? `@${user.username}` : user.user_id);
}

/** One typed Telegram user id: digits only. Null for anything else. */
export function parseTelegramUserId(raw: string): string | null {
  const id = raw.trim();
  return /^\d{1,20}$/.test(id) ? id : null;
}

const onError = (error: Error) => errorToast(error.message);

export function TelegramUsersPanel({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const tPages = useTranslations('connectorPages');
  const users = useTelegramUsers(projectId, true);
  const remove = useRemoveTelegramUser();
  const [removing, setRemoving] = useState<TelegramUser | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const allowedHeading = useRef<HTMLHeadingElement>(null);
  const requests = users.data?.requests ?? [];
  const allowed = users.data?.allowed ?? [];
  const removingName = removing ? telegramUserName(removing) : '';

  return (
    <>
      <ModalHeader>
        <ModalTitle>{t.raw('text2c3059c25723')}</ModalTitle>
        <ModalDescription>{tPages('telegramUsersDescription')}</ModalDescription>
      </ModalHeader>
      <ModalBody>
        {users.isError && !users.data ? (
          <ErrorState
            size="sm"
            title={tPages('telegramUsersLoadError')}
            action={
              <Button variant="outline" size="sm" onClick={() => void users.refetch()}>
                {t.raw('textd8b8392e2c54')}
              </Button>
            }
          />
        ) : (
          // The lists scroll; the add field and the footer stay put. Capped like
          // the channel list in channels-view.tsx, so the footer stays on screen
          // at the 720 × 480 desktop minimum, where this modal is a bottom sheet.
          <div className="max-h-[min(45vh,calc(100dvh-21rem))] space-y-4 overflow-y-auto">
            {requests.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium">
                  {tPages('telegramRequestsTitle')}
                  <CountBadge count={requests.length} tone="waiting" />
                </h3>
                <ul className="space-y-2">
                  {requests.map((user) => (
                    <RequestRow key={user.user_id} projectId={projectId} user={user} />
                  ))}
                </ul>
              </section>
            ) : null}
            <section className="space-y-2">
              {/* Focus lands here after a Remove: the row and its kebab are gone. */}
              <h3
                ref={allowedHeading}
                tabIndex={-1}
                className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium outline-none"
              >
                {tPages('telegramAllowedTitle')}
                {allowed.length > 0 ? <CountBadge count={allowed.length} /> : null}
              </h3>
              {users.isPending ? (
                <div className="space-y-2">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              ) : allowed.length === 0 ? (
                <EmptyState
                  size="sm"
                  media={<EmptyArt icon={UsersIcon} />}
                  title={tPages('telegramUsersEmptyTitle')}
                  description={tPages('telegramUsersEmptyDescription')}
                />
              ) : (
                <ul className="space-y-2">
                  {allowed.map((user) => {
                    const name = telegramUserName(user);
                    return (
                      <TelegramUserRow
                        key={user.user_id}
                        projectId={projectId}
                        user={user}
                        pending={remove.isPending && remove.variables?.userId === user.user_id}
                        kebabLabel={t('text33da220b1a34', { value0: name })}
                        kebab={[
                          {
                            label: t.raw('textc3812fc4acb8'),
                            variant: 'destructive',
                            onSelect: () => {
                              setRemoving(user);
                              setConfirmOpen(true);
                            },
                          },
                        ]}
                      />
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
        <AddByIdField projectId={projectId} />
      </ModalBody>
      <ModalFooter className="pt-2 pb-5">
        <Button type="button" variant="outline-ghost" onClick={onDone}>
          {t.raw('text11a6767d5674')}
        </Button>
      </ModalFooter>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={tPages('telegramRemoveTitle', { name: removingName })}
        description={tPages('telegramRemoveDescription', { name: removingName })}
        confirmLabel={t.raw('textc3812fc4acb8')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(
            { projectId, userId: removing.user_id },
            {
              onSuccess: () => {
                setConfirmOpen(false);
                allowedHeading.current?.focus();
              },
              onError,
            },
          );
        }}
      />
    </>
  );
}

function RequestRow({ projectId, user }: { projectId: string; user: TelegramUser }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const tPages = useTranslations('connectorPages');
  const allow = useAllowTelegramUser();
  const dismiss = useDismissTelegramAccessRequest();
  const name = telegramUserName(user);
  const busy = allow.isPending || dismiss.isPending;
  const vars = { projectId, userId: user.user_id };

  return (
    <TelegramUserRow
      projectId={projectId}
      user={user}
      pending={busy}
      actions={
        <Button
          size="sm"
          disabled={busy}
          aria-busy={allow.isPending}
          aria-label={tPages('telegramAllowAria', { name })}
          onClick={() => allow.mutate(vars, { onError })}
        >
          {t.raw('texte213c161d5ce')}
        </Button>
      }
      kebabLabel={t('text33da220b1a34', { value0: name })}
      kebab={[{ label: t.raw('text48845bff334a'), onSelect: () => dismiss.mutate(vars, { onError }) }]}
    />
  );
}

/** One person as an access card: photo or initials, name, @username, the id in mono. */
function TelegramUserRow({
  projectId,
  user,
  ...row
}: { projectId: string; user: TelegramUser } & Pick<
  AccessRowProps,
  'actions' | 'kebab' | 'kebabLabel' | 'pending'
>) {
  const name = telegramUserName(user);
  const nameIsId = name === user.user_id;
  const handle = user.username ? `@${user.username}` : null;

  return (
    <AccessRow
      leading={<TelegramUserAvatar projectId={projectId} user={user} name={name} />}
      title={nameIsId ? <span className="font-mono tabular-nums">{name}</span> : name}
      metaParts={[
        handle && handle !== name ? handle : null,
        nameIsId ? null : <span className="font-mono tabular-nums">{user.user_id}</span>,
      ].filter(Boolean)}
      {...row}
    />
  );
}

function TelegramUserAvatar({ projectId, user, name }: { projectId: string; user: TelegramUser; name: string }) {
  const { data: photo } = useTelegramUserPhoto(projectId, user.user_id, user.photo_version, true);
  const [url, setUrl] = useState<string | null>(null);
  // The object URL lives as long as this blob: a new photo or an unmount revokes it.
  useEffect(() => {
    if (!photo) return;
    const next = URL.createObjectURL(photo);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [photo]);

  // The id keys the fallback colour, as an email does for a member.
  return <UserAvatar email={user.user_id} name={name} avatarUrl={url} size="md" />;
}

function AddByIdField({ projectId }: { projectId: string }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const tPages = useTranslations('connectorPages');
  const allow = useAllowTelegramUser();
  const inputId = useId();
  const [value, setValue] = useState('');
  const id = parseTelegramUserId(value);
  const invalid = value.trim() !== '' && !id;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!id) return;
        allow.mutate({ projectId, userId: id }, { onSuccess: () => setValue(''), onError });
      }}
    >
      <Field>
        <FieldLabel htmlFor={inputId}>{tPages('telegramAddByIdLabel')}</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={inputId}
            size="sm"
            inputMode="numeric"
            autoComplete="off"
            placeholder="123456789"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={invalid}
          />
          <Button type="submit" variant="outline" disabled={!id || allow.isPending} aria-busy={allow.isPending}>
            {t.raw('text9fd728c66c9a')}
          </Button>
        </div>
        <FieldDescription>
          {invalid ? tPages('telegramAddByIdInvalid') : tPages('telegramAddByIdHint')}
        </FieldDescription>
      </Field>
    </form>
  );
}
