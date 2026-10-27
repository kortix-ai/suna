'use client';

import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Textarea } from '@kortix/ui/textarea';
import { CheckCircleIcon } from '@phosphor-icons/react';
import { useMutation } from 'convex/react';
import Link from 'next/link';
import { useState } from 'react';

const SIZES = [
  ['1', 'Just me'],
  ['2-10', '2–10 lawyers'],
  ['11-50', '11–50 lawyers'],
  ['51+', '51 or more'],
] as const;

type Size = (typeof SIZES)[number][0];

/** The demo request: two-column inputs, one pill submit. */
export function DemoForm() {
  const request = useMutation(api.marketing.requestDemo);
  const [size, setSize] = useState<Size | ''>('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!size) return setError('Choose your team size.');
    setPending(true);
    setError('');
    try {
      await request({
        name: String(f.get('name') ?? ''),
        email: String(f.get('email') ?? ''),
        firm: String(f.get('firm') ?? ''),
        role: String(f.get('role') ?? ''),
        message: String(f.get('message') ?? ''),
        size,
      });
      setDone(true);
    } catch (err) {
      setError(errorText(err).replace(/^\d{3}: /, ''));
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="flex flex-col items-start gap-4">
        <CheckCircleIcon className="size-8 text-verified" weight="fill" />
        <h2 className="display-xs">Thank you. We will be in touch within one working day.</h2>
        <p className="text-[15px] text-muted-foreground">Want to look around first? The free trial opens with a sample matter of six agreements.</p>
        <Link href="/sign-up" className="inline-flex h-10 items-center rounded-full bg-navy px-5 text-[15px] font-medium text-white dark:bg-[#F5F3EF] dark:text-navy">
          Start free trial
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-5 sm:grid-cols-2" noValidate>
      <Field id="name" label="Full name" autoComplete="name" />
      <Field id="email" label="Work email" type="email" autoComplete="email" />
      <Field id="firm" label="Firm or company" autoComplete="organization" />
      <Field id="role" label="Role" autoComplete="organization-title" required={false} />
      <div className="grid gap-2 sm:col-span-2">
        <Label htmlFor="size" className="text-[14px] font-medium">
          Team size
        </Label>
        <Select value={size} onValueChange={(v) => setSize(v as Size)}>
          <SelectTrigger id="size" className="h-11 w-full rounded-[4px]">
            <SelectValue placeholder="Select" />
          </SelectTrigger>
          <SelectContent>
            {SIZES.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2 sm:col-span-2">
        <Label htmlFor="message" className="text-[14px] font-medium">
          What would you like to see? <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea id="message" name="message" rows={3} className="rounded-[4px]" />
      </div>
      {error && (
        <p role="alert" className="text-[14px] text-risk sm:col-span-2">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="h-11 rounded-full text-[15px] sm:col-span-2">
        {pending ? <Loading className="size-4" /> : 'Request demo'}
      </Button>
      <p className="text-[13px] text-muted-foreground sm:col-span-2">
        We use these details only to arrange the demo. See the <Link href="/legal/privacy" className="underline underline-offset-4">privacy notice</Link>.
      </p>
    </form>
  );
}

function Field({ id, label, type = 'text', autoComplete, required = true }: { id: string; label: string; type?: string; autoComplete?: string; required?: boolean }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id} className="text-[14px] font-medium">
        {label}
        {!required && <span className="font-normal text-muted-foreground"> (optional)</span>}
      </Label>
      <Input id={id} name={id} type={type} autoComplete={autoComplete} required={required} className="h-11 rounded-[4px]" />
    </div>
  );
}
