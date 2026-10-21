'use client';

import { useFirm } from '@/components/access';
import { AdminOnly } from '@/components/admin-only';
import { authClient } from '@/lib/auth-client';
import { roleLabel } from '@/lib/roles';
import { api } from '@convex/_generated/api';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { errorToast, successToast } from '@kortix/ui/toast';
import { CopyIcon, PaperPlaneTiltIcon, PlusIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import Link from 'next/link';
import { useState } from 'react';

const inviteLink = (id: string) => `${window.location.origin}/invite/${id}`;

function copy(id: string) {
  navigator.clipboard.writeText(inviteLink(id)).then(() => successToast('Invitation link copied'));
}

export default function MembersPage() {
  return (
    <AdminOnly>
      <Members />
    </AdminOnly>
  );
}

function Members() {
  const firm = useFirm();
  const active = authClient.useActiveOrganization();
  const { data: auth } = authClient.useSession();
  const seats = useQuery(api.billing.summary, { firmId: firm._id });
  const org = active.data;
  const pending = org?.invitations.filter((i) => i.status === 'pending' && new Date(i.expiresAt).getTime() > Date.now()) ?? [];
  const full = seats ? seats.used + seats.pending >= seats.seats : false;
  const me = org?.members.find((m) => m.userId === auth?.user.id);

  async function changeRole(memberId: string, role: string) {
    const { error } = await authClient.organization.updateMemberRole({ memberId, role: role as 'admin' | 'member' });
    if (error) errorToast('Could not change the role', { description: error.message });
    else successToast('Role updated');
    active.refetch();
  }
  async function remove(memberId: string, email: string) {
    if (!window.confirm(`Remove ${email} from ${firm.name}? They lose access to every matter.`)) return;
    const { error } = await authClient.organization.removeMember({ memberIdOrEmail: memberId });
    if (error) errorToast('Could not remove', { description: error.message });
    else successToast(`${email} removed`);
    active.refetch();
  }
  async function revoke(invitationId: string) {
    const { error } = await authClient.organization.cancelInvitation({ invitationId });
    if (error) errorToast('Could not revoke', { description: error.message });
    active.refetch();
  }
  async function resend(email: string, role: string) {
    const { error } = await authClient.organization.inviteMember({ email, role: role as 'admin' | 'member', resend: true });
    if (error) errorToast('Could not resend', { description: error.message });
    else successToast(`Invitation to ${email} renewed`);
    active.refetch();
  }

  return (
    <div className="space-y-8">
      <InviteForm full={full} seats={seats?.seats} onInvited={() => active.refetch()} />

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Members</h2>
          {seats && (
            <span className="font-mono text-xs text-muted-foreground" data-testid="seat-usage">
              {seats.used + seats.pending} / {seats.seats} seats
            </span>
          )}
        </div>
        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="w-40">Role</TableHead>
                <TableHead className="w-28">Joined</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {!org && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Loading className="size-4" />
                  </TableCell>
                </TableRow>
              )}
              {org?.members.map((m) => {
                const editable = m.role !== 'owner' && m.userId !== auth?.user.id && (me?.role === 'owner' || m.role !== 'admin');
                return (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.user.name}</TableCell>
                    <TableCell className="text-muted-foreground">{m.user.email}</TableCell>
                    <TableCell>
                      {editable ? (
                        <Select value={m.role} onValueChange={(r) => changeRole(m.id, r)}>
                          <SelectTrigger aria-label={`Role of ${m.user.email}`} className="h-8 w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Lawyer</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline">{roleLabel(m.role)}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(m.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>
                      {editable && (
                        <Button variant="ghost" size="icon" className="size-8" aria-label={`Remove ${m.user.email}`} onClick={() => remove(m.id, m.user.email)}>
                          <TrashIcon className="size-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      {pending.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium">Pending invitations</h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label="Pending invitations">
            {pending.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{i.email}</span>
                <Badge variant="outline">{roleLabel(i.role ?? 'member')}</Badge>
                <span className="w-32 text-xs text-muted-foreground">expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`Copy link for ${i.email}`} onClick={() => copy(i.id)}>
                  <CopyIcon className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`Resend to ${i.email}`} onClick={() => resend(i.email, i.role ?? 'member')}>
                  <PaperPlaneTiltIcon className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`Revoke ${i.email}`} onClick={() => revoke(i.id)}>
                  <XIcon className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Invite by email. Lumen sends no email in this example: the invitation is a
 * link the admin shares. The seat rule runs on the server (Better Auth's
 * beforeCreateInvitation hook); this form shows the same limit up front.
 */
function InviteForm({ full, seats, onInvited }: { full: boolean; seats?: number; onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setRefused(null);
    const { data, error } = await authClient.organization.inviteMember({ email: email.trim(), role });
    setPending(false);
    if (error || !data) {
      if (error?.status === 403 && /seat/i.test(error.message ?? '')) setRefused(error.message ?? 'All seats are in use.');
      else errorToast('Could not invite', { description: error?.message });
      return;
    }
    setLink(inviteLink(data.id));
    setEmail('');
    onInvited();
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-medium">Invite a colleague</h2>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={invite}>
        <div className="min-w-60 flex-1 space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@example.com" />
        </div>
        <Select value={role} onValueChange={(r) => setRole(r as 'member' | 'admin')}>
          <SelectTrigger aria-label="Invite role" className="h-9 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">Lawyer</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={pending || !email.trim()}>
          {pending ? <Loading className="size-4" /> : <PlusIcon className="size-4" />} Invite
        </Button>
      </form>
      {(refused || full) && (
        <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/60 px-3 py-2 text-sm">
          <span>{refused ?? `All ${seats} seats are in use. Add seats to invite more people.`}</span>
          <Button asChild size="sm" variant="secondary">
            <Link href="/app/settings/billing">Add seats</Link>
          </Button>
        </div>
      )}
      {link && (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="invite-link">Share this link with your colleague</Label>
          <div className="flex gap-2">
            <Input id="invite-link" readOnly value={link} className="font-mono text-xs" />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Copy invitation link"
              onClick={() => navigator.clipboard.writeText(link).then(() => successToast('Link copied'))}
            >
              <CopyIcon className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
