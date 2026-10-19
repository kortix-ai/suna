'use client';

import { authClient } from '@/lib/auth-client';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@kortix/ui/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { errorToast, successToast } from '@kortix/ui/toast';
import { CopyIcon, PlusIcon, SignOutIcon, UsersIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BrandMark } from './brand-mark';

const NEW_ORG = '__new__';

/** Brand, organization switcher, members and sign-out. Organizations are Better Auth's. */
export function AppHeader({ onCreateOrg }: { onCreateOrg: () => void }) {
  const router = useRouter();
  const orgs = authClient.useListOrganizations();
  const active = authClient.useActiveOrganization();
  const { data: auth } = authClient.useSession();

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-4xl items-center gap-3 px-5 py-3">
        <Link href="/" aria-label="Lumen home">
          <BrandMark />
        </Link>
        {(orgs.data?.length ?? 0) > 0 && (
          <Select
            value={active.data?.id ?? ''}
            onValueChange={async (organizationId) => {
              if (organizationId === NEW_ORG) return onCreateOrg();
              await authClient.organization.setActive({ organizationId });
              router.push('/');
            }}
          >
            <SelectTrigger aria-label="Organization" className="h-8 w-auto min-w-40 gap-2 text-sm">
              <SelectValue placeholder="Organization" />
            </SelectTrigger>
            <SelectContent>
              {orgs.data?.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
              <SelectItem value={NEW_ORG}>New organization…</SelectItem>
            </SelectContent>
          </Select>
        )}
        <div className="flex-1" />
        {active.data && <MembersDialog />}
        <span className="hidden text-xs text-muted-foreground sm:inline">{auth?.user.email}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await authClient.signOut();
            router.push('/');
          }}
        >
          <SignOutIcon className="size-4" /> Sign out
        </Button>
      </div>
    </header>
  );
}

/**
 * Members of the active organization, and the invite form. Lumen sends no
 * email in this example: an invitation is a link the inviter shares. The
 * recipient signs in with the invited address and accepts at /invite/<id>.
 */
function MembersDialog() {
  const active = authClient.useActiveOrganization();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const org = active.data;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const { data, error } = await authClient.organization.inviteMember({ email: email.trim(), role: 'member' });
    setPending(false);
    if (error || !data) return errorToast('Could not invite', { description: error?.message });
    setLink(`${window.location.origin}/invite/${data.id}`);
    setEmail('');
    active.refetch();
  }

  return (
    <Modal onOpenChange={() => setLink(null)}>
      <ModalTrigger asChild>
        <Button variant="ghost" size="sm">
          <UsersIcon className="size-4" /> Members
        </Button>
      </ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>{org?.name} members</ModalTitle>
          <ModalDescription>Members see every workspace and thread in this organization.</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <ul className="space-y-1.5" aria-label="Members">
            {org?.members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{m.user.email}</span>
                <Badge variant="outline">{m.role}</Badge>
              </li>
            ))}
            {org?.invitations
              .filter((i) => i.status === 'pending')
              .map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span className="truncate">{i.email}</span>
                  <Badge variant="secondary">invited</Badge>
                </li>
              ))}
          </ul>
          <form className="flex items-end gap-2" onSubmit={invite}>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="invite-email">Invite by email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@company.com"
              />
            </div>
            <Button type="submit" disabled={pending || !email.trim()}>
              {pending ? <Loading className="size-4" /> : <PlusIcon className="size-4" />} Invite
            </Button>
          </form>
          {link && (
            <div className="space-y-1.5">
              <Label htmlFor="invite-link">Invitation link</Label>
              <div className="flex gap-2">
                <Input id="invite-link" readOnly value={link} className="font-mono text-xs" />
                <Button
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
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

/** Create an organization and make it the active one. */
export function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const slug = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`;
    const { data, error } = await authClient.organization.create({ name: name.trim(), slug });
    if (data) await authClient.organization.setActive({ organizationId: data.id });
    setPending(false);
    if (error || !data) return errorToast('Could not create the organization', { description: error?.message });
    setName('');
    onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>New organization</ModalTitle>
          <ModalDescription>Your company or team. Workspaces and members belong to it.</ModalDescription>
        </ModalHeader>
        <form onSubmit={create}>
          <ModalBody className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Organization name</Label>
              <Input id="org-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Capital" />
            </div>
            <Button type="submit" className="w-full" disabled={pending || !name.trim()}>
              {pending && <Loading className="size-4" />} Create organization
            </Button>
          </ModalBody>
        </form>
      </ModalContent>
    </Modal>
  );
}
