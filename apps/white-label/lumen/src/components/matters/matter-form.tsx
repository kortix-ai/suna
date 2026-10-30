'use client';

import { useFirm } from '@/components/access';
import { authClient } from '@/lib/auth-client';
import { PARTY_ROLES } from '@/lib/roles';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { RadioGroup, RadioGroupItem } from '@kortix/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { errorToast } from '@kortix/ui/toast';
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';

type PartyRole = (typeof PARTY_ROLES)[number];
type Party = { name: string; role: PartyRole };

/** The parties editor: a name and a role per row. */
export function PartiesField({ parties, onChange }: { parties: Party[]; onChange: (p: Party[]) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>Parties</Label>
      <div className="space-y-2">
        {parties.map((p, i) => (
          <div key={i} className="flex gap-2">
            <Input
              aria-label={`Party ${i + 1} name`}
              value={p.name}
              placeholder="Party name"
              onChange={(e) => onChange(parties.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <Select value={p.role} onValueChange={(role) => onChange(parties.map((x, j) => (j === i ? { ...x, role: role as PartyRole } : x)))}>
              <SelectTrigger aria-label={`Party ${i + 1} role`} className="w-40 capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PARTY_ROLES.map((r) => (
                  <SelectItem key={r} value={r} className="capitalize">
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove party ${i + 1}`} onClick={() => onChange(parties.filter((_, j) => j !== i))}>
              <XIcon className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => onChange([...parties, { name: '', role: 'counterparty' }])}>
        <PlusIcon className="size-4" /> Add party
      </Button>
    </div>
  );
}

/** Who sees the matter: the whole firm, or the listed lawyers plus admins. */
export function VisibilityField({
  visibility, onVisibility, members, onMembers, excludeUserId,
}: {
  visibility: 'firm' | 'restricted';
  onVisibility: (v: 'firm' | 'restricted') => void;
  members: string[];
  onMembers: (m: string[]) => void;
  excludeUserId?: string;
}) {
  const firm = useFirm();
  const directory = useQuery(api.members.directory, visibility === 'restricted' ? { firmId: firm._id } : 'skip');
  const lawyers = directory?.filter((d) => d.role === 'member' && d.userId !== excludeUserId) ?? [];
  return (
    <div className="space-y-2">
      <Label>Visibility</Label>
      <RadioGroup value={visibility} onValueChange={(v) => onVisibility(v as 'firm' | 'restricted')} className="gap-2">
        <label className="flex items-start gap-2.5 text-sm">
          <RadioGroupItem value="firm" className="mt-0.5" />
          <span>
            <span className="font-medium">Whole firm</span>
            <span className="block text-xs text-muted-foreground">Every member of {firm.name} can open it.</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-sm">
          <RadioGroupItem value="restricted" className="mt-0.5" />
          <span>
            <span className="font-medium">Restricted</span>
            <span className="block text-xs text-muted-foreground">Only the people you add, and firm admins.</span>
          </span>
        </label>
      </RadioGroup>
      {visibility === 'restricted' && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-xs text-muted-foreground">Lawyers on this matter</p>
          {directory === undefined && <Loading className="size-4" />}
          {directory && lawyers.length === 0 && <p className="text-sm text-muted-foreground">No other lawyers in the firm yet.</p>}
          <div className="space-y-1.5">
            {lawyers.map((d) => (
              <label key={d.userId} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={members.includes(d.userId)}
                  onCheckedChange={(c) => onMembers(c ? [...members, d.userId] : members.filter((m) => m !== d.userId))}
                />
                <span className="truncate">{d.name || d.email}</span>
                <span className="truncate text-xs text-muted-foreground">{d.email}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** "New matter": name, number, client, parties, practice area, visibility. */
export function NewMatterDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: Id<'matters'>) => void;
}) {
  const firm = useFirm();
  const { data: auth } = authClient.useSession();
  const create = useMutation(api.matters.create);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [client, setClient] = useState('');
  const [practiceArea, setPracticeArea] = useState('');
  const [parties, setParties] = useState<Party[]>([]);
  const [visibility, setVisibility] = useState<'firm' | 'restricted'>('firm');
  const [members, setMembers] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  function reset() {
    setName(''); setNumber(''); setClient(''); setPracticeArea(''); setParties([]); setVisibility('firm'); setMembers([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const id = await create({
        firmId: firm._id, name, number: number || undefined, client, parties: parties.filter((p) => p.name.trim()),
        practiceArea: practiceArea || undefined, visibility, members,
      });
      reset();
      onCreated(id);
    } catch (err) {
      errorToast('Could not create the matter', { description: errorText(err) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-xl">
        <ModalHeader>
          <ModalTitle>New matter</ModalTitle>
          <ModalDescription>A matter holds the documents, conversations and reviews for one piece of work.</ModalDescription>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody className="max-h-[70dvh] space-y-4 overflow-y-auto">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="matter-name">Matter name</Label>
                <Input id="matter-name" autoFocus required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Project Aster" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="matter-number">Number</Label>
                <Input id="matter-number" maxLength={40} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="M-0001" className="font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="matter-client">Client</Label>
                <Input id="matter-client" maxLength={120} value={client} onChange={(e) => setClient(e.target.value)} placeholder="Brightwater Example Holdings" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="matter-area">Practice area</Label>
                <Input id="matter-area" maxLength={60} value={practiceArea} onChange={(e) => setPracticeArea(e.target.value)} placeholder="M&A" />
              </div>
            </div>
            <PartiesField parties={parties} onChange={setParties} />
            <VisibilityField visibility={visibility} onVisibility={setVisibility} members={members} onMembers={setMembers} excludeUserId={auth?.user.id} />
            <Button type="submit" className="w-full" disabled={pending || !name.trim()}>
              {pending && <Loading className="size-4" />} Create matter
            </Button>
          </ModalBody>
        </form>
      </ModalContent>
    </Modal>
  );
}

