'use client';

import { SignedIn } from '@/components/access';
import { BrandMark } from '@/components/brand-mark';
import { SIZE_BANDS, TagsInput } from '@/components/firm-fields';
import { useAddSampleMatter } from '@/components/matters/sample-matter';
import { authClient } from '@/lib/auth-client';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { errorToast } from '@kortix/ui/toast';
import { CheckIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';

const STEPS = ['Name your firm', 'Invite colleagues', 'Try a sample matter'];

export default function OnboardingPage() {
  return (
    <SignedIn>
      <Suspense>
        <Onboarding />
      </Suspense>
    </SignedIn>
  );
}

function Onboarding() {
  const fresh = useSearchParams().get('new') === '1';
  const active = authClient.useActiveOrganization();
  const [step, setStep] = useState(0);
  const [firmId, setFirmId] = useState<Id<'firms'> | null>(null);
  // An organization without a firm row (setup stopped after step 1's first half) resumes here.
  const resumeOrg = !fresh && active.data ? active.data : null;
  const existing = useQuery(api.firms.forOrg, resumeOrg ? { orgId: resumeOrg.id } : 'skip');
  const router = useRouter();
  // Set when the person submits step 1: from then on a firm appearing is theirs, not a reason to leave.
  const started = useRef(false);

  if (!fresh && existing && !started.current) {
    router.replace('/app');
    return null;
  }

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex max-w-xl flex-col px-6 py-10">
        <BrandMark />
        <ol aria-label="Setup steps" className="mt-10 flex items-center gap-3 text-xs">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2" aria-current={i === step ? 'step' : undefined}>
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full border font-mono',
                  i < step ? 'border-brand bg-brand text-brand-foreground' : i === step ? 'border-brand text-brand' : 'border-border text-muted-foreground',
                )}
              >
                {i < step ? <CheckIcon className="size-3" /> : i + 1}
              </span>
              <span className={i === step ? 'text-foreground' : 'text-muted-foreground'}>{s}</span>
              {i < STEPS.length - 1 && <span className="h-px w-6 bg-border" />}
            </li>
          ))}
        </ol>
        <div className="mt-8">
          {step === 0 && (
            <NameFirm
              onStart={() => (started.current = true)}
              resumeOrg={resumeOrg && existing === null ? resumeOrg : null}
              onDone={(id) => {
                setFirmId(id);
                setStep(1);
              }}
            />
          )}
          {step === 1 && firmId && <Invite onDone={() => setStep(2)} />}
          {step === 2 && firmId && <Sample firmId={firmId} />}
        </div>
      </div>
    </div>
  );
}

function NameFirm({ resumeOrg, onStart, onDone }: {
  resumeOrg: { id: string; name: string } | null; onStart: () => void; onDone: (id: Id<'firms'>) => void;
}) {
  const createFirm = useMutation(api.firms.create);
  const [name, setName] = useState(resumeOrg?.name ?? '');
  const [tags, setTags] = useState<string[]>([]);
  const [sizeBand, setSizeBand] = useState<(typeof SIZE_BANDS)[number]['value']>('2-10');
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    onStart();
    try {
      let orgId = resumeOrg?.id;
      if (!orgId) {
        const slug = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`;
        const { data, error } = await authClient.organization.create({ name: name.trim(), slug });
        if (error || !data) throw new Error(error?.message ?? 'Could not create the firm');
        orgId = data.id;
      }
      await authClient.organization.setActive({ organizationId: orgId });
      onDone(await createFirm({ orgId, name, practiceTags: tags, sizeBand }));
    } catch (err) {
      setPending(false);
      errorToast('Could not set up the firm', { description: errorText(err) });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Name your firm</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your matters, documents and colleagues live in one firm workspace.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="firm-name">Firm name</Label>
        <Input id="firm-name" autoFocus required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Example & Co. Legal" />
      </div>
      <TagsInput value={tags} onChange={setTags} />
      <div className="space-y-1.5">
        <Label>Size</Label>
        <Select value={sizeBand} onValueChange={(v) => setSizeBand(v as typeof sizeBand)}>
          <SelectTrigger aria-label="Firm size" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SIZE_BANDS.map((b) => (
              <SelectItem key={b.value} value={b.value}>
                {b.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={pending || name.trim().length < 2}>
        {pending && <Loading className="size-4" />} Continue
      </Button>
    </form>
  );
}

function Invite({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState([{ email: '', role: 'member' as 'member' | 'admin' }]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setPending(true);
    setError(null);
    for (const r of rows.filter((x) => x.email.trim())) {
      const { error } = await authClient.organization.inviteMember({ email: r.email.trim(), role: r.role });
      if (error) {
        setPending(false);
        setError(`${r.email}: ${error.message}`);
        return;
      }
    }
    onDone();
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Invite your colleagues</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Each gets a link to join. You can do this later in Settings. Your workspace is being set up in the meantime.
        </p>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2">
            <Input
              type="email"
              aria-label={`Colleague ${i + 1} email`}
              value={r.email}
              placeholder="colleague@example.com"
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
            />
            <Select value={r.role} onValueChange={(role) => setRows(rows.map((x, j) => (j === i ? { ...x, role: role as 'member' | 'admin' } : x)))}>
              <SelectTrigger aria-label={`Colleague ${i + 1} role`} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Lawyer</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            {rows.length > 1 && (
              <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <XIcon className="size-4" />
              </Button>
            )}
          </div>
        ))}
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setRows([...rows, { email: '', role: 'member' }])}>
          <PlusIcon className="size-4" /> Add another
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={send} disabled={pending || !rows.some((r) => r.email.trim())}>
          {pending && <Loading className="size-4" />} Send invitations
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}

/** A fictional sample matter, with its six synthetic agreements, so the firm has something to open. */
function Sample({ firmId }: { firmId: Id<'firms'> }) {
  const router = useRouter();
  const sample = useAddSampleMatter();
  const pending = sample.progress !== null;

  async function add() {
    try {
      const id = await sample.add(firmId);
      router.replace(`/app/matters/${id}/vault`);
    } catch (err) {
      errorToast('Could not add the sample matter', { description: errorText(err) });
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Try it on a sample matter</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A fictional acquisition: six agreements with fictional parties, ready to search, ask about and review before you add real work.
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={add} disabled={pending}>
          {pending && <Loading className="size-4" />} {sample.progress ?? 'Add the sample matter'}
        </Button>
        <Button variant="ghost" onClick={() => router.replace('/app')}>
          Start empty
        </Button>
      </div>
    </div>
  );
}
