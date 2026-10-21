'use client';

import { useFirm } from '@/components/access';
import { useTheme, type ThemeChoice } from '@/components/theme';
import { ACTIONS } from '@/lib/audit-labels';
import { authClient } from '@/lib/auth-client';
import { downloadCsv } from '@/lib/csv';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { DesktopIcon, DownloadSimpleIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
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

/** Your account: profile, appearance, password, sessions and your own activity. Every member, any role. */
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
    </div>
  );
}
