'use client';

import type {
  CaptureDevice,
  CaptureEnrollment,
  CaptureEnrollmentToken,
  CaptureEnrollmentTokenSecret,
} from '@kortix/sdk';
import {
  useApproveCaptureEnrollment,
  useCaptureEnrollments,
  useCaptureEnrollmentTokens,
  useCreateCaptureEnrollmentToken,
  useDenyCaptureEnrollment,
  useLinkCaptureDevice,
  useRevokeCaptureEnrollmentToken,
} from '@kortix/sdk/react';
import { ArrowSquareOutIcon, CheckIcon, CopyIcon, DesktopIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CountBadge } from '@/components/ui/count-badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { useCopy } from '@/hooks/use-copy';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { getEnv } from '@/lib/env-config';
import { relativeTime } from '@/lib/relative-time';

import { useCaptureDirectory } from '../area/use-capture-area';
import {
  enrollmentUrl,
  EXPIRY_DAYS,
  expiryDate,
  installCommand,
  parseDomains,
  parseLimit,
  personLabel,
  ROLLOUT_OS,
  type ExpiryDays,
  type RolloutOs,
} from './rollout-model';

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * "Roll out to computers" (`capture.manage`): the enrollment tokens IT installs
 * Kortix Capture with, and a form for a new one. A new token is shown once,
 * with the silent install command.
 */
export function RolloutModal({
  open,
  onOpenChange,
  accountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
}) {
  const t = useTranslations('capture.rollout');
  const tokens = useCaptureEnrollmentTokens(open ? accountId : null);
  const [created, setCreated] = useState<CaptureEnrollmentTokenSecret | null>(null);
  // Revoked and expired tokens enroll nothing: kept out of sight until asked for.
  const [showInactive, setShowInactive] = useState(false);
  const all = tokens.data?.tokens ?? [];
  const inactive = all.filter((token) => token.state !== 'active');
  const shown = showInactive ? all : all.filter((token) => token.state === 'active');
  const close = (next: boolean) => {
    if (!next) setCreated(null);
    onOpenChange(next);
  };
  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-8 overflow-y-auto">
          {created ? (
            <CreatedToken token={created} />
          ) : (
            <NewTokenForm accountId={accountId} onCreated={setCreated} />
          )}
          <section className="space-y-3">
            <Label>{t('tokensTitle')}</Label>
            {tokens.isLoading ? (
              <Skeleton className="h-16 rounded-md" />
            ) : shown.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('tokensEmpty')}</p>
            ) : (
              <ul className="bg-popover divide-border divide-y rounded-md border">
                {shown.map((token) => (
                  <TokenRow key={token.token_id} accountId={accountId} token={token} />
                ))}
              </ul>
            )}
            {inactive.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowInactive((v) => !v)}
              >
                {showInactive ? t('hideRevoked') : t('showRevoked', { count: inactive.length })}
              </Button>
            ) : null}
          </section>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link href="/docs/capture/rollout" target="_blank">
              {t('guide')}
              <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            </Link>
          </Button>
          <Button size="sm" onClick={() => close(false)}>
            {t('done')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function NewTokenForm({
  accountId,
  onCreated,
}: {
  accountId: string;
  onCreated: (token: CaptureEnrollmentTokenSecret) => void;
}) {
  const t = useTranslations('capture.rollout');
  const create = useCreateCaptureEnrollmentToken(accountId);
  const ids = { name: useId(), person: useId(), domains: useId(), limit: useId(), approval: useId() };
  const [name, setName] = useState('');
  const [person, setPerson] = useState<string | null>(null);
  const [domains, setDomains] = useState('');
  const [limit, setLimit] = useState('');
  const [expiry, setExpiry] = useState<ExpiryDays>(30);
  const [approval, setApproval] = useState(false);
  const submit = () =>
    create.mutate(
      {
        name: name.trim(),
        email_domains: person ? [] : parseDomains(domains),
        max_devices: parseLimit(limit),
        require_approval: approval,
        expires_in_days: expiry,
        user_id: person,
      },
      { onSuccess: onCreated, onError: (error) => errorToast(errorText(error, t('createFailed'))) },
    );
  return (
    <section className="space-y-3">
      <Label>{t('newTitle')}</Label>
      <div className="bg-popover divide-border divide-y rounded-md border">
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
          <span>
            <Label htmlFor={ids.name} className="text-sm font-medium">
              {t('name')}
            </Label>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('nameHint')}</p>
          </span>
          <Input
            id={ids.name}
            value={name}
            maxLength={100}
            placeholder={t('namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
          <span>
            <p id={ids.person} className="text-sm font-medium">
              {t('for')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('forHint')}</p>
          </span>
          <MemberSelect
            accountId={accountId}
            enabled
            value={person}
            noneLabel={t('forAnyone')}
            labelledBy={ids.person}
            onChange={(next) => {
              setPerson(next);
              // A personal token installs that person's computer: cap it at one unless the admin says more.
              setLimit(next ? '1' : '');
            }}
          />
        </div>
        {person ? null : (
          <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
            <span>
              <Label htmlFor={ids.domains} className="text-sm font-medium">
                {t('domains')}
              </Label>
              <p className="text-muted-foreground mt-0.5 text-xs">{t('domainsHint')}</p>
            </span>
            <Input
              id={ids.domains}
              value={domains}
              placeholder={t('domainsPlaceholder')}
              onChange={(event) => setDomains(event.target.value)}
            />
          </div>
        )}
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
          <span>
            <Label htmlFor={ids.limit} className="text-sm font-medium">
              {t('limit')}
            </Label>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('limitHint')}</p>
          </span>
          <Input
            id={ids.limit}
            type="number"
            min={1}
            value={limit}
            placeholder="20"
            className="w-28 tabular-nums"
            onChange={(event) => setLimit(event.target.value)}
          />
        </div>
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
          <p className="text-sm font-medium">{t('expires')}</p>
          <Select
            value={String(expiry)}
            onValueChange={(value) =>
              setExpiry(value === 'null' ? null : (Number(value) as ExpiryDays))
            }
          >
            <SelectTrigger size="sm" aria-label={t('expires')} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_DAYS.map((days) => (
                <SelectItem key={String(days)} value={String(days)}>
                  {days === null ? t('never') : t('days', { days })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p id={ids.approval} className="text-foreground text-sm font-medium">
              {t('approval')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{t('approvalHint')}</p>
          </div>
          <Switch aria-labelledby={ids.approval} checked={approval} onCheckedChange={setApproval} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!name.trim() || create.isPending}
          aria-busy={create.isPending}
          onClick={submit}
        >
          {create.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('create')}
        </Button>
      </div>
    </section>
  );
}

/** The new token, once: the secret and the silent install command, each copyable. */
function CreatedToken({ token }: { token: CaptureEnrollmentTokenSecret }) {
  const t = useTranslations('capture.rollout');
  const url = enrollmentUrl(getEnv().BACKEND_URL);
  const [os, setOs] = useState<RolloutOs>('windows');
  return (
    <section className="space-y-3" aria-live="polite">
      <Label>{t('createdTitle', { name: token.name })}</Label>
      <p className="text-muted-foreground text-xs text-pretty">{t('createdBody')}</p>
      <CopyBlock text={token.token} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('installTitle')}</p>
        <Tabs value={os} onValueChange={(value) => setOs(value as RolloutOs)}>
          <TabsListCompact aria-label={t('installTitle')}>
            {ROLLOUT_OS.map((value) => (
              <TabsTriggerCompact key={value} value={value}>
                {t(`os.${value}`)}
              </TabsTriggerCompact>
            ))}
          </TabsListCompact>
        </Tabs>
      </div>
      <CopyBlock text={installCommand(os, url, token.token)} />
      <p className="text-muted-foreground text-xs text-pretty">{t(`installBody.${os}`)}</p>
    </section>
  );
}

function TokenRow({ accountId, token }: { accountId: string; token: CaptureEnrollmentToken }) {
  const t = useTranslations('capture.rollout');
  const locale = useLocale();
  const revoke = useRevokeCaptureEnrollmentToken(accountId);
  const [confirm, setConfirm] = useState(false);
  const people = useCaptureDirectory(accountId, token.user_id !== null);
  const person = token.user_id
    ? (people.members.find((member) => member.user_id === token.user_id)?.email ?? token.user_id)
    : null;
  const usage =
    token.max_devices === null
      ? t('usage', { count: token.device_count })
      : t('usageOf', { count: token.device_count, max: token.max_devices });
  const expiry = token.expires_at
    ? t(token.state === 'expired' ? 'expired' : 'expiresIn', {
        time: expiryDate(token.expires_at, locale),
      })
    : t('noExpiry');
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-foreground flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{token.name}</span>
          {token.state === 'active' ? null : (
            <Badge variant="outline" size="xs">
              {t(`state.${token.state}`)}
            </Badge>
          )}
          {token.require_approval ? (
            <Badge variant="outline" size="xs">
              {t('approvalBadge')}
            </Badge>
          ) : null}
        </p>
        <p className="text-muted-foreground mt-0.5 truncate text-xs tabular-nums">
          <code className="font-mono">{token.token_prefix}…</code> · {usage} ·{' '}
          {person
            ? t('forPerson', { person })
            : token.email_domains.length
              ? token.email_domains.join(', ')
              : t('anyDomain')}{' '}
          · {expiry}
        </p>
      </div>
      {token.state === 'active' ? (
        <Button variant="outline-ghost" size="sm" onClick={() => setConfirm(true)}>
          {t('revoke')}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('revokeTitle', { name: token.name })}
        description={t('revokeBody')}
        confirmLabel={t('revoke')}
        confirmVariant="destructive"
        isPending={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(token.token_id, {
            onSuccess: () => {
              successToast(t('revoked'));
              setConfirm(false);
            },
            onError: (error) => errorToast(errorText(error, t('revokeFailed'))),
          })
        }
      />
    </li>
  );
}

/** A copyable line: the token or the install command. */
function CopyBlock({ text }: { text: string }) {
  const t = useTranslations('capture.rollout');
  const { copy, copied } = useCopy();
  return (
    <div className="bg-muted flex items-start rounded-md border">
      <pre className="scrollbar-hide min-w-0 flex-1 overflow-x-auto py-2.5 pl-3 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => copy(text)}
        aria-label={t('copy')}
        className="m-1 size-7 shrink-0"
      >
        {copied ? (
          <CheckIcon className="text-kortix-green size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </Button>
    </div>
  );
}

// ─── Waiting computers ───────────────────────────────────────────────────────

/**
 * Computers that presented an enrollment token and wait for a decision: their
 * person is no member yet, or the token approves each computer. Shown above
 * the device list while any waits.
 */
export function WaitingComputers({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.rollout');
  const waiting = useCaptureEnrollments(accountId, { status: 'pending' });
  const rows = waiting.data?.enrollments ?? [];
  const [approving, setApproving] = useState<CaptureEnrollment | null>(null);
  if (rows.length === 0) return null;
  return (
    <section aria-label={t('waitingTitle')} className="space-y-3">
      <div className="flex items-center gap-2">
        <Label>{t('waitingTitle')}</Label>
        <CountBadge count={rows.length} tone="waiting" />
      </div>
      <p className="text-muted-foreground text-xs text-pretty">{t('waitingBody')}</p>
      <Table className="min-w-3xl">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">{t('col.person')}</TableHead>
            <TableHead>{t('col.computer')}</TableHead>
            <TableHead>{t('col.reason')}</TableHead>
            <TableHead>{t('col.lastSeen')}</TableHead>
            <TableHead className="pr-4">
              <span className="sr-only">{t('col.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <WaitingRow
              key={row.enrollment_id}
              accountId={accountId}
              row={row}
              onApprove={() => setApproving(row)}
            />
          ))}
        </TableBody>
      </Table>
      <ApproveModal accountId={accountId} row={approving} onClose={() => setApproving(null)} />
    </section>
  );
}

function WaitingRow({
  accountId,
  row,
  onApprove,
}: {
  accountId: string;
  row: CaptureEnrollment;
  onApprove: () => void;
}) {
  const t = useTranslations('capture.rollout');
  const locale = useLocale();
  const deny = useDenyCaptureEnrollment(accountId);
  const [confirm, setConfirm] = useState(false);
  const person = personLabel(row);
  return (
    <TableRow>
      <TableCell className="pl-4">
        <span className="text-foreground block truncate font-medium">{person}</span>
        {row.principal_name && row.account_name ? (
          <span className="text-muted-foreground block truncate text-xs">{row.account_name}</span>
        ) : null}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          <DesktopIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{row.device.name ?? t('unnamed')}</span>
        </span>
        <span className="text-muted-foreground block text-xs">{row.token_name}</span>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-72 min-w-56 text-xs text-pretty whitespace-normal">
        {t('reason.approval_required')}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">
        {relativeTime(Date.parse(row.last_seen_at), locale)}
      </TableCell>
      <TableCell className="pr-4 text-right">
        <span className="inline-flex items-center gap-1">
          <Button variant="outline-ghost" size="sm" onClick={() => setConfirm(true)}>
            {t('deny')}
          </Button>
          <Button size="sm" onClick={onApprove}>
            {t('approve')}
          </Button>
        </span>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={t('denyTitle', { person })}
          description={t('denyBody')}
          confirmLabel={t('deny')}
          confirmVariant="destructive"
          isPending={deny.isPending}
          onConfirm={() =>
            deny.mutate(row.enrollment_id, {
              onSuccess: () => {
                successToast(t('denied'));
                setConfirm(false);
              },
              onError: (error) => errorToast(errorText(error, t('decideFailed'))),
            })
          }
        />
      </TableCell>
    </TableRow>
  );
}

/** The Select value for "linked to no one". */
const NO_ONE = 'none';

/** A member of the account, or "linked to no one". */
function MemberSelect({
  accountId,
  enabled,
  value,
  noneLabel,
  labelledBy,
  onChange,
}: {
  accountId: string;
  enabled: boolean;
  value: string | null;
  /** The label of the null choice; default "Linked to no one". */
  noneLabel?: string;
  labelledBy?: string;
  onChange: (userId: string | null) => void;
}) {
  const t = useTranslations('capture.rollout');
  const people = useCaptureDirectory(accountId, enabled);
  return (
    <Select
      value={value ?? NO_ONE}
      onValueChange={(next) => onChange(next === NO_ONE ? null : next)}
    >
      <SelectTrigger
        aria-label={labelledBy ? undefined : t('member')}
        aria-labelledby={labelledBy}
        className="w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ONE}>{noneLabel ?? t('noOne')}</SelectItem>
        {people.members.map((member) => (
          <SelectItem key={member.user_id} value={member.user_id}>
            {member.email ?? member.user_id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Approve a waiting computer, linked to a member or to no one. The matched member is preselected. */
function ApproveModal({
  accountId,
  row,
  onClose,
}: {
  accountId: string;
  row: CaptureEnrollment | null;
  onClose: () => void;
}) {
  const t = useTranslations('capture.rollout');
  const approve = useApproveCaptureEnrollment(accountId);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const userId = picked === undefined ? (row?.user_id ?? null) : picked;
  const close = () => {
    setPicked(undefined);
    onClose();
  };
  return (
    <Modal open={row !== null} onOpenChange={(open) => (open ? null : close())}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('approveTitle')}</ModalTitle>
          <ModalDescription>
            {row
              ? t('approveBody', {
                  person: personLabel(row),
                  computer: row.device.name ?? t('unnamed'),
                })
              : null}
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <MemberSelect
            accountId={accountId}
            enabled={row !== null}
            value={userId}
            onChange={setPicked}
          />
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            disabled={approve.isPending}
            aria-busy={approve.isPending}
            onClick={() =>
              row &&
              approve.mutate(
                { enrollmentId: row.enrollment_id, userId },
                {
                  onSuccess: () => {
                    successToast(t('approved'));
                    close();
                  },
                  onError: (error) => errorToast(errorText(error, t('decideFailed'))),
                },
              )
            }
          >
            {approve.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            {t('approve')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/**
 * Link a device to a Kortix user, or unlink it (`capture.manage`). What it
 * recorded linked to no one moves to the person; what it recorded for an
 * earlier person stays theirs.
 */
export function LinkDeviceModal({
  accountId,
  device,
  name,
  onClose,
}: {
  accountId: string;
  device: CaptureDevice | null;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations('capture.rollout');
  const link = useLinkCaptureDevice(accountId);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const userId = picked === undefined ? (device?.user_id ?? null) : picked;
  const close = () => {
    setPicked(undefined);
    onClose();
  };
  return (
    <Modal open={device !== null} onOpenChange={(open) => (open ? null : close())}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('linkTitle', { name })}</ModalTitle>
          <ModalDescription>{t('linkBody')}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <MemberSelect
            accountId={accountId}
            enabled={device !== null}
            value={userId}
            onChange={setPicked}
          />
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            disabled={link.isPending || !device || userId === device.user_id}
            aria-busy={link.isPending}
            onClick={() =>
              device &&
              link.mutate(
                { deviceId: device.device_id, userId },
                {
                  onSuccess: () => {
                    successToast(userId ? t('linked') : t('unlinked'));
                    close();
                  },
                  onError: (error) => errorToast(errorText(error, t('linkFailed'))),
                },
              )
            }
          >
            {link.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            {t('save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
