'use client';

/**
 * "Invite people to {workspace}" (design.md §3.1 finding 19, C3): email
 * chips, ONE role from the workspace ladder (Member, Manager, Admin; Owner is
 * a transfer, never an invite), and an optional expiry. It sends
 * `POST /v1/workspaces/:id/members {email, role, expires_at}` once per email.
 * The server writes the storage the role needs, so the dialog never asks for
 * a project grant. A `split_pending` workspace (a legacy account that still
 * holds several workspaces) keeps the per-workspace grant dialog
 * (`AccessDialog`).
 *
 * The same body renders in the account hub's split sheet (Members › Invite)
 * and in a Modal.
 */

import { inviteWorkspaceMember, type WorkspaceRole } from '@kortix/sdk';
import { XIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';

import { useTranslations } from '../../i18n';
import { useInAccountHubSheetBody } from '../../internal/account-hub/hub-sheet';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { Field, FieldDescription, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { errorToast, successToast } from '../../primitives/toast';
import { ExpiryPicker, MODAL_CHROME, SHEET_CHROME } from './access-dialog';
import { endOfLocalDayIso } from './access-shared';
import { isInviteEmail } from './principal-picker';

/** The roles an invite can carry, lowest first. */
export type InviteRole = Exclude<WorkspaceRole, 'owner'>;
export const INVITE_ROLES: readonly InviteRole[] = ['member', 'manager', 'admin'];

/**
 * Split typed text into emails: commas, semicolons, spaces and new lines
 * separate them. Returns the valid emails (lowercased, de-duplicated against
 * `existing`) and what is left over (a partial or invalid entry stays typed).
 */
export function parseInviteEmails(
  text: string,
  existing: readonly string[],
): { emails: string[]; rest: string } {
  const parts = text.split(/[\s,;]+/);
  const emails: string[] = [];
  const rest: string[] = [];
  const seen = new Set(existing);
  for (const part of parts) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (isInviteEmail(value)) {
      if (!seen.has(value)) {
        seen.add(value);
        emails.push(value);
      }
    } else {
      rest.push(part.trim());
    }
  }
  return { emails, rest: rest.join(' ') };
}

export interface InvitePeopleDialogProps {
  workspaceId: string;
  workspaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `member.update`: only then may an invite make an Admin. */
  canGrantAdmin: boolean;
  /** After the invites were sent (members, invites and probes changed). */
  onDone?: () => void;
}

export function InvitePeopleDialog({
  workspaceId,
  workspaceName,
  open,
  onOpenChange,
  canGrantAdmin,
  onDone,
}: InvitePeopleDialogProps) {
  const t = useTranslations('workspaces.invite');
  const tRoles = useTranslations('workspaces.roles');
  const chrome = useInAccountHubSheetBody() ? SHEET_CHROME : MODAL_CHROME;
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [expires, setExpires] = useState('');
  const [failures, setFailures] = useState<Array<{ email: string; message: string }>>([]);

  const commit = (text: string) => {
    const parsed = parseInviteEmails(text, emails);
    if (parsed.emails.length > 0) setEmails((current) => [...current, ...parsed.emails]);
    setDraft(parsed.rest);
    return parsed;
  };

  const send = useMutation({
    mutationFn: async (list: string[]) => {
      const expiresIso = endOfLocalDayIso(expires);
      const results = await Promise.allSettled(
        list.map((email) =>
          inviteWorkspaceMember(workspaceId, { email, role, ...(expiresIso ? { expires_at: expiresIso } : {}) }),
        ),
      );
      return results.map((result, index) => ({
        email: list[index]!,
        ok: result.status === 'fulfilled',
        message: result.status === 'rejected' ? (result.reason as Error)?.message || t('sendFailed') : '',
      }));
    },
    onSuccess: (results) => {
      const sent = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      if (sent.length > 0) {
        successToast(t('sentToast', { count: sent.length }));
        onDone?.();
      }
      setFailures(failed.map(({ email, message }) => ({ email, message })));
      // The emails that failed stay as chips, so a fix is one more click.
      setEmails(failed.map((result) => result.email));
      if (failed.length === 0) {
        setEmails([]);
        setExpires('');
        setRole('member');
        onOpenChange(false);
      }
    },
    onError: (error: Error) => errorToast(error.message || t('sendFailed')),
  });

  const pending = send.isPending;
  const submit = () => {
    const parsed = commit(draft);
    const list = [...emails, ...parsed.emails];
    if (list.length === 0 || parsed.rest) return;
    send.mutate(list);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ' ' || event.key === 'Tab') {
      if (!draft.trim()) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
        return;
      }
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && !draft && emails.length > 0) {
      setEmails((current) => current.slice(0, -1));
    }
  };
  const invalidDraft = draft.trim().length > 0 && !isInviteEmail(draft);
  const canSubmit = !pending && (emails.length > 0 || isInviteEmail(draft));
  const roles = INVITE_ROLES.filter((value) => value !== 'admin' || canGrantAdmin);

  return (
    <chrome.Root open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <chrome.Content>
        <chrome.Header>
          <chrome.Title>{t('title', { name: workspaceName })}</chrome.Title>
          <chrome.Description>{t('description')}</chrome.Description>
        </chrome.Header>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <chrome.Body>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="invite-emails">{t('emailsLabel')}</FieldLabel>
              <div
                className="bg-popover focus-within:ring-ring flex min-h-9 flex-wrap items-center gap-1 rounded-md border px-2 py-1 focus-within:ring-1"
                data-testid="invite-emails"
              >
                {emails.map((email) => (
                  <Badge key={email} variant="secondary" size="sm" className="gap-1">
                    {email}
                    <button
                      type="button"
                      aria-label={t('removeEmail', { email })}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setEmails((current) => current.filter((value) => value !== email))}
                      disabled={pending}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Badge>
                ))}
                <input
                  id="invite-emails"
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                  onBlur={() => draft.trim() && commit(draft)}
                  onPaste={(event) => {
                    const text = event.clipboardData.getData('text');
                    if (/[\s,;]/.test(text)) {
                      event.preventDefault();
                      commit(`${draft} ${text}`);
                    }
                  }}
                  placeholder={emails.length === 0 ? t('emailsPlaceholder') : undefined}
                  aria-invalid={invalidDraft || undefined}
                  disabled={pending}
                  className="text-foreground placeholder:text-muted-foreground min-w-32 flex-1 bg-transparent py-1 text-sm outline-none"
                />
              </div>
              <FieldDescription>{invalidDraft ? t('invalidEmail') : t('emailsHint')}</FieldDescription>
            </Field>

            <Field className="gap-1.5">
              <FieldLabel htmlFor="invite-role">{t('roleLabel')}</FieldLabel>
              <Select value={role} onValueChange={(value) => setRole(value as InviteRole)} disabled={pending}>
                <SelectTrigger id="invite-role" size="md" className="w-full">
                  <SelectValue>{tRoles(`${role}.label`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {roles.map((value) => (
                    <SelectItem key={value} value={value} textValue={tRoles(`${value}.label`)}>
                      <span className="flex flex-col gap-0.5">
                        <span>{tRoles(`${value}.label`)}</span>
                        <span className="text-muted-foreground text-xs">{tRoles(`${value}.blurb`)}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t('ownerHint')}</FieldDescription>
            </Field>

            <Field className="gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <FieldLabel htmlFor="invite-expires">{t('expiresLabel')}</FieldLabel>
                <span className="text-muted-foreground text-xs">{t('optional')}</span>
              </div>
              <ExpiryPicker id="invite-expires" value={expires} onChange={setExpires} disabled={pending} />
              <FieldDescription>{t('expiresHint')}</FieldDescription>
            </Field>

            {failures.length > 0 ? (
              <ul role="alert" className="space-y-1" data-testid="invite-failures">
                {failures.map((failure) => (
                  <li key={failure.email} className="text-destructive text-xs">
                    <span className="font-medium">{failure.email}</span>: {failure.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </chrome.Body>
          <chrome.Footer>
            <Button type="button" variant="outline-ghost" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit} className="gap-1.5" data-testid="invite-send">
              {pending ? <Loading className="size-4 shrink-0" /> : null}
              {t('send', { count: Math.max(1, emails.length + (isInviteEmail(draft) ? 1 : 0)) })}
            </Button>
          </chrome.Footer>
        </form>
      </chrome.Content>
    </chrome.Root>
  );
}

