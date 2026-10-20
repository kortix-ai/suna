'use client';

import { useFirm, useMatter } from '@/components/access';
import { HistoryList } from '@/components/runs/history-list';
import { PartiesField, VisibilityField } from '@/components/matters/matter-form';
import { roleLabel } from '@/lib/roles';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { errorToast, successToast } from '@kortix/ui/toast';
import { ChatCircleTextIcon, PencilSimpleIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { useState } from 'react';

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function MatterOverview() {
  const { matter, members, canManage } = useMatter();
  const firm = useFirm();
  const history = useQuery(api.workflows.history, { matterId: matter._id });
  const directory = useQuery(api.members.directory, { firmId: firm._id });
  const [editing, setEditing] = useState(false);
  const [access, setAccess] = useState(false);
  const who = (id: string) => directory?.find((d) => d.userId === id);

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <section>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Recent activity</h2>
            <Button asChild size="sm" variant="secondary">
              <Link href={`/app/matters/${matter._id}/assistant`}>
                <ChatCircleTextIcon className="size-4" /> Ask Lumen
              </Link>
            </Button>
          </div>
          <HistoryList items={history?.slice(0, 8)} rows={3} empty="Questions, reviews and workflows on this matter appear here." />
          {history && history.length > 8 && (
            <Link href={`/app/matters/${matter._id}/history`} className="mt-2 inline-block text-xs text-muted-foreground hover:text-foreground">
              All {history.length} in History
            </Link>
          )}
        </section>

        <Section
          title="Details"
          action={
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <PencilSimpleIcon className="size-4" /> Edit
            </Button>
          }
        >
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Client</dt>
            <dd>{matter.client || '—'}</dd>
            <dt className="text-muted-foreground">Number</dt>
            <dd className="font-mono text-xs leading-5">{matter.number || '—'}</dd>
            <dt className="text-muted-foreground">Practice area</dt>
            <dd>{matter.practiceArea || '—'}</dd>
            <dt className="text-muted-foreground">Opened</dt>
            <dd>{new Date(matter._creationTime).toLocaleDateString()}</dd>
          </dl>
        </Section>
      </div>

      <div className="space-y-4">
        <Section title="Parties">
          {matter.parties.length === 0 ? (
            <p className="text-sm text-muted-foreground">No parties yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {matter.parties.map((p, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="truncate">{p.name}</span>
                  <span className="text-xs capitalize text-muted-foreground">{p.role}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Who can see it"
          action={
            canManage && (
              <Button size="sm" variant="ghost" onClick={() => setAccess(true)}>
                <UsersThreeIcon className="size-4" /> Manage
              </Button>
            )
          }
        >
          {matter.visibility === 'firm' ? (
            <p className="text-sm text-muted-foreground">Everyone at {firm.name}.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {members.map((id) => (
                <li key={id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{who(id)?.name || who(id)?.email || '…'}</span>
                  <span className="text-xs text-muted-foreground">{who(id) ? roleLabel(who(id)!.role) : ''}</span>
                </li>
              ))}
              <li className="pt-1 text-xs text-muted-foreground">Firm admins can always open it.</li>
            </ul>
          )}
        </Section>
      </div>

      {editing && <EditDetails onClose={() => setEditing(false)} />}
      {access && <EditAccess onClose={() => setAccess(false)} />}
    </div>
  );
}

function EditDetails({ onClose }: { onClose: () => void }) {
  const { matter } = useMatter();
  const update = useMutation(api.matters.update);
  const [name, setName] = useState(matter.name);
  const [number, setNumber] = useState(matter.number ?? '');
  const [client, setClient] = useState(matter.client);
  const [practiceArea, setPracticeArea] = useState(matter.practiceArea ?? '');
  const [parties, setParties] = useState(matter.parties);
  const [pending, setPending] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await update({ matterId: matter._id, name, number, client, practiceArea, parties: parties.filter((p) => p.name.trim()) });
      successToast('Matter updated');
      onClose();
    } catch (err) {
      errorToast('Could not save', { description: errorText(err) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="sm:max-w-xl">
        <ModalHeader>
          <ModalTitle>Edit matter</ModalTitle>
        </ModalHeader>
        <form onSubmit={save}>
          <ModalBody className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="edit-name">Matter name</Label>
                <Input id="edit-name" required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-number">Number</Label>
                <Input id="edit-number" value={number} onChange={(e) => setNumber(e.target.value)} className="font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-client">Client</Label>
                <Input id="edit-client" value={client} onChange={(e) => setClient(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-area">Practice area</Label>
                <Input id="edit-area" value={practiceArea} onChange={(e) => setPracticeArea(e.target.value)} />
              </div>
            </div>
            <PartiesField parties={parties} onChange={setParties} />
            <Button type="submit" className="w-full" disabled={pending || !name.trim()}>
              {pending && <Loading className="size-4" />} Save
            </Button>
          </ModalBody>
        </form>
      </ModalContent>
    </Modal>
  );
}

function EditAccess({ onClose }: { onClose: () => void }) {
  const { matter, members: current } = useMatter();
  const update = useMutation(api.matters.update);
  const [visibility, setVisibility] = useState(matter.visibility);
  const [members, setMembers] = useState(current);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    try {
      await update({ matterId: matter._id, visibility, ...(visibility === 'restricted' ? { members } : {}) });
      successToast('Access updated');
      onClose();
    } catch (err) {
      errorToast('Could not save', { description: errorText(err) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open onOpenChange={(o) => !o && onClose()}>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>Who can see {matter.name}</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <VisibilityField visibility={visibility} onVisibility={setVisibility} members={members} onMembers={setMembers} excludeUserId={matter.createdBy} />
          <Button className="w-full" onClick={save} disabled={pending}>
            {pending && <Loading className="size-4" />} Save
          </Button>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
