'use client';

import { useFirm } from '@/components/access';
import { useTheme, type ThemeChoice } from '@/components/theme';
import { ACTIONS } from '@/lib/audit-labels';
import { authClient } from '@/lib/auth-client';
import { downloadCsv } from '@/lib/csv';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { DesktopIcon, DownloadSimpleIcon, MoonIcon, ShieldCheckIcon, SunIcon, TrashIcon } from '@phosphor-icons/react';
import { useConvex, useQuery } from 'convex/react';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

function Card({ title, body, children }: { title: string; body?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="font-display text-xl tracking-[-0.02em]">{title}</h2>
      {body && <p className="mt-1 text-sm text-muted-foreground">{body}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Your account: profile, appearance, password, two-step sign-in, your own activity, your data and deleting the account. Every member, any role. */
export default function AccountPage() {
  const firm = useFirm();
  const { data } = authClient.useSession();
  const { choice, setChoice } = useTheme();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [changing, setChanging] = useState(false);
  const activity = useQuery(api.audit.mine, { firmId: firm._id });
  useEffect(() => setName(data?.user.name ?? ''), [data?.user.name]);

  async function saveName() {
    setSaving(true);
    const { error } = await authClient.updateUser({ name: name.trim() });
    setSaving(false);
    if (error) errorToast('Could not save your name', { description: error.message });
    else successToast('Name saved');
  }

  async function changePassword() {
    setChanging(true);
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setChanging(false);
    if (error) return errorToast('Could not change the password', { description: error.message });
    setCurrent('');
    setNext('');
    successToast('Password changed', { description: 'Your other sessions were signed out.' });
  }

  function exportActivity() {
    if (!activity) return;
    downloadCsv('my-lumen-activity.csv', [
      ['When', 'Action', 'Matter', 'Detail'],
      ...activity.map((r) => [new Date(r._creationTime).toISOString(), ACTIONS[r.action] ?? r.action, r.matterName ?? '', r.detail ?? '']),
    ]);
  }

  return (
    <div className="space-y-5">
      <Card title="Profile" body="How colleagues see you in Lumen.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="acc-name">Name</Label>
            <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-email">Email</Label>
            <Input id="acc-email" value={data?.user.email ?? ''} disabled />
          </div>
        </div>
        <Button className="mt-4" size="sm" disabled={saving || !name.trim() || name.trim() === data?.user.name} onClick={saveName}>
          {saving && <Loading className="size-4" />} Save
        </Button>
      </Card>

      <Card title="Appearance" body="Saved in this browser.">
        <div className="grid max-w-md grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {(
            [
              ['light', 'Light', SunIcon],
              ['dark', 'Dark', MoonIcon],
              ['system', 'System', DesktopIcon],
            ] as const
          ).map(([v, label, Icon]) => (
            <Button
              key={v}
              variant="outline"
              role="radio"
              aria-checked={choice === v}
              onClick={() => setChoice(v as ThemeChoice)}
              className={cn('h-16 flex-col gap-1.5 font-normal', choice === v && 'border-brand ring-1 ring-brand')}
            >
              <Icon className="size-4" />
              {label}
            </Button>
          ))}
        </div>
      </Card>

      <Card title="Password" body="Changing it signs you out everywhere else.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="acc-current">Current password</Label>
            <Input id="acc-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-new">New password</Label>
            <Input id="acc-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
        </div>
        <Button className="mt-4" size="sm" disabled={changing || !current || next.length < 8} onClick={() => changePassword().catch((e) => errorToast('Could not change the password', { description: errorText(e) }))}>
          {changing && <Loading className="size-4" />} Change password
        </Button>
      </Card>

      <TwoStepCard orgId={firm.orgId} enabled={!!(data?.user as { twoFactorEnabled?: boolean | null } | undefined)?.twoFactorEnabled} />

      <Card title="My activity" body={`What you did at ${firm.name}, newest first. The firm’s audit log keeps the same record.`}>
        <div className="mb-3 flex justify-end">
          <Button size="sm" variant="outline" disabled={!activity?.length} onClick={exportActivity}>
            <DownloadSimpleIcon className="size-4" /> Export CSV
          </Button>
        </div>
        {activity === undefined && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="my-1.5 h-8" />)}
        {activity?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>}
        <ul className="divide-y divide-border border-y border-border" data-testid="my-activity">
          {activity?.slice(0, 50).map((r) => (
            <li key={r._id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">{relativeTime(new Date(r._creationTime).toISOString())}</span>
              <span className="font-medium">{ACTIONS[r.action] ?? r.action}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{[r.matterName, r.detail].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      </Card>

      <DataCard firmId={firm._id} />
      <DeleteCard />
    </div>
  );
}

/** The secret in an otpauth:// URI, grouped in fours for typing into an authenticator app. */
const setupKey = (uri: string) => (new URL(uri).searchParams.get('secret') ?? '').replace(/(.{4})/g, '$1 ').trim();

/**
 * Two-step sign-in (Better Auth twoFactor, TOTP): turn on with the password, add the key to an
 * authenticator app, confirm one code, keep the backup codes. Turn off with the password.
 */
function TwoStepCard({ enabled, orgId }: { enabled: boolean; orgId: string }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    try {
      await fn();
    } catch (e) {
      errorToast('Two-step sign-in', { description: errorText(e) });
    } finally {
      setPending(false);
    }
  };
  const start = () =>
    run(async () => {
      const { data, error } = await authClient.twoFactor.enable({ password });
      if (error) throw new Error(error.message);
      setSetup({ uri: data.totpURI, backupCodes: data.backupCodes });
      setPassword('');
    });
  const confirm = () =>
    run(async () => {
      const { error } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
      if (error) throw new Error(error.message);
      // Confirming the code issues a fresh sign-in session: keep this firm active in it.
      await authClient.organization.setActive({ organizationId: orgId });
      setSetup(null);
      setCode('');
      successToast('Two-step sign-in is on', { description: 'Lumen asks for a code from your app each time you sign in.' });
    });
  const turnOff = () =>
    run(async () => {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) throw new Error(error.message);
      setPassword('');
      successToast('Two-step sign-in is off');
    });
  return (
    <Card title="Two-step sign-in" body="A code from an authenticator app at every sign-in, on top of your password.">
      {setup ? (
        <div className="space-y-4" data-testid="two-step-setup">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            <li>
              In your authenticator app, add an account with this key, or{' '}
              <a className="underline underline-offset-2" href={setup.uri}>open it on this device</a>:
              <code className="mt-1 block w-fit rounded-md bg-muted px-2 py-1 font-mono text-[13px]" data-testid="two-step-key">{setupKey(setup.uri)}</code>
            </li>
            <li>
              Keep these backup codes somewhere safe. Each signs you in once without the app:
              <code className="mt-1 grid w-fit grid-cols-2 gap-x-6 rounded-md bg-muted px-2 py-1 font-mono text-[13px]" data-testid="two-step-backup">
                {setup.backupCodes.map((c) => <span key={c}>{c}</span>)}
              </code>
            </li>
            <li>Enter the code the app shows now.</li>
          </ol>
          <div className="flex max-w-sm gap-2">
            <Input aria-label="Code from your app" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" />
            <Button size="sm" className="h-9" disabled={pending || !code.trim()} onClick={confirm}>
              {pending && <Loading className="size-4" />} Turn on
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex max-w-md flex-wrap items-end gap-2">
          <p className="w-full text-sm" data-testid="two-step-state">
            <ShieldCheckIcon className="mr-1 inline size-4 align-[-3px]" /> {enabled ? 'On.' : 'Off.'}
          </p>
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="tf-password">Password</Label>
            <Input id="tf-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Button size="sm" className="h-9" variant={enabled ? 'outline' : 'default'} disabled={pending || !password} onClick={enabled ? turnOff : start}>
            {pending && <Loading className="size-4" />} {enabled ? 'Turn off' : 'Set up'}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Download my data: everything Lumen holds about the caller in this firm, as JSON (`account.myData`). */
function DataCard({ firmId }: { firmId: Id<'firms'> }) {
  const convex = useConvex();
  const [pending, setPending] = useState(false);
  async function download() {
    setPending(true);
    try {
      const data = await convex.query(api.account.myData, { firmId });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'my-lumen-data.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      errorToast('Could not export your data', { description: errorText(e) });
    } finally {
      setPending(false);
    }
  }
  return (
    <Card title="Your data" body="Your profile, the matters, conversations and documents you created here, and your activity, in one JSON file.">
      <Button size="sm" variant="outline" disabled={pending} onClick={download} data-testid="download-my-data">
        {pending ? <Loading className="size-4" /> : <DownloadSimpleIcon className="size-4" />} Download my data
      </Button>
    </Card>
  );
}

/** Delete my account: Better Auth deleteUser with the password; refused while a firm would be left without an owner. */
function DeleteCard() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  async function remove() {
    setConfirming(false);
    const { error } = await authClient.deleteUser({ password });
    if (error) return errorToast('Could not delete your account', { description: error.message });
    successToast('Your account was deleted');
    router.replace('/');
  }
  return (
    <Card title="Delete account" body="Removes your sign-in and your access to every firm. The firm keeps its matters, documents, conversations and audit log.">
      <div className="flex max-w-md flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="del-password">Password</Label>
          <Input id="del-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button size="sm" className="h-9" variant="destructive" disabled={!password} onClick={() => setConfirming(true)} data-testid="delete-account">
          <TrashIcon className="size-4" /> Delete account
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete your account?"
        description="You lose access to every firm at once. This cannot be undone."
        confirmLabel="Delete account"
        confirmVariant="destructive"
        onConfirm={remove}
      />
    </Card>
  );
}
