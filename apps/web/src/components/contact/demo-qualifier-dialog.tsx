'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, Loader2, Mail } from 'lucide-react';
import Cal, { getCalApi } from '@calcom/embed-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ─────────────────────────────────────────────────────────────────────────────
// Shared demo qualifier
//
// One screening gate in front of EVERY booking calendar (public /contact demo
// AND the in-app "Book a call with Marko" widget). Visitors answer a couple of
// minimal questions; we persist all of it (/api/demo-request) and route them:
//   • company big enough → the booking calendar (answers prefilled)
//   • 1–10               → self-serve (no call needed)
//
// Cal only prefills a custom field when the config KEY equals its identifier and
// (for a dropdown) the VALUE matches an option verbatim — so the identifiers +
// COMPANY_SIZES values mirror the Cal "Booking questions" config 1:1. A target
// event that lacks a given field simply ignores that prefill key (harmless).
// ─────────────────────────────────────────────────────────────────────────────

const CAL_FIELD_COMPANY_SIZE = 'Company_size';
const CAL_FIELD_COMPANY_NAME = 'Company_name';

const CONTACT_EMAIL = 'hey@kortix.ai';

type CompanySize = '1-10' | '11-50' | '51-200' | '201-1000' | '1000+';

const COMPANY_SIZES: { value: CompanySize; qualifies: boolean }[] = [
  { value: '1-10', qualifies: false },
  { value: '11-50', qualifies: true },
  { value: '51-200', qualifies: true },
  { value: '201-1000', qualifies: true },
  { value: '1000+', qualifies: true },
];

const sizeQualifies = (s: CompanySize) =>
  COMPANY_SIZES.find((o) => o.value === s)?.qualifies ?? false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DemoQualifierDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Cal event to send qualified leads to (e.g. `team/kortix/demo`). */
  calLink: string;
  /** A namespace UNIQUE to this calLink so embed UI config stays isolated. */
  calNamespace: string;
  /** Capture label so we can tell which surface a lead came from. */
  source?: string;
  title?: string;
  description?: string;
  /** Prefill for logged-in surfaces (the in-app widget). */
  defaultName?: string;
  defaultEmail?: string;
  /** Where the self-serve (disqualified) CTA points. */
  selfServeHref?: string;
}

export function DemoQualifierDialog({
  open,
  onOpenChange,
  calLink,
  calNamespace,
  source = 'contact',
  title = 'Book your demo',
  description = "A couple of quick details so we can tailor the session — or point you to self-serve if that's faster.",
  defaultName = '',
  defaultEmail = '',
  selfServeHref = '/auth',
}: DemoQualifierDialogProps) {
  const [step, setStep] = useState<'form' | 'cal' | 'selfserve'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [company, setCompany] = useState('');
  const [size, setSize] = useState<CompanySize | null>(null);
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Start on the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setStep('form');
      setError(null);
    }
  }, [open]);

  // Apply prefill if it arrives after mount (logged-in user resolves late).
  useEffect(() => {
    if (defaultName) setName((n) => n || defaultName);
  }, [defaultName]);
  useEffect(() => {
    if (defaultEmail) setEmail((e) => e || defaultEmail);
  }, [defaultEmail]);

  useEffect(() => {
    (async function () {
      const cal = await getCalApi({ namespace: calNamespace });
      cal('ui', { hideEventTypeDetails: false, layout: 'month_view' });
      cal('on', {
        action: 'bookingSuccessful',
        callback: () => window.setTimeout(() => onOpenChange(false), 1500),
      });
    })();
  }, [calNamespace, onOpenChange]);

  const submit = useCallback(async () => {
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid work email so we can reach you.');
      return;
    }
    if (!size) {
      setError('Pick your company size.');
      return;
    }
    setError(null);
    const qualified = sizeQualifies(size);

    // Persist the lead — best-effort: capture failures must never block routing.
    setSubmitting(true);
    try {
      await fetch('/api/demo-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          company_name: company.trim(),
          company_size: size,
          goal: goal.trim(),
          qualified,
          source,
        }),
      });
    } catch {
      /* swallow — routing happens regardless */
    } finally {
      setSubmitting(false);
    }

    setStep(qualified ? 'cal' : 'selfserve');
  }, [email, size, name, company, goal, source]);

  // Answers ride into the booking as prefill, keyed by each Cal field identifier.
  const calConfig: Record<string, string> = { layout: 'month_view' };
  if (name.trim()) calConfig.name = name.trim();
  if (email.trim()) calConfig.email = email.trim();
  if (company.trim()) calConfig[CAL_FIELD_COMPANY_NAME] = company.trim();
  if (size) calConfig[CAL_FIELD_COMPANY_SIZE] = size;
  if (goal.trim()) calConfig.notes = `Goal: ${goal.trim()}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {step === 'cal' ? (
        <DialogContent
          hideCloseButton
          className="max-w-[min(980px,95vw)] gap-0 overflow-hidden rounded-2xl border-none bg-transparent p-0 shadow-none"
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <div className="h-[82vh] max-h-[780px] overflow-hidden rounded-2xl">
            <Cal
              namespace={calNamespace}
              calLink={calLink}
              style={{ width: '100%', height: '100%' }}
              config={calConfig}
            />
          </div>
        </DialogContent>
      ) : step === 'form' ? (
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[420px]">
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 px-6 py-5">
              <div className="space-y-1.5">
                <Label htmlFor="dq-name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="dq-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-email">
                  Work email <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="dq-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-company">Company name</Label>
                <Input
                  id="dq-company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Acme Inc."
                  autoComplete="organization"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-size">
                  Company size <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={size ?? undefined}
                  onValueChange={(v) => setSize(v as CompanySize)}
                >
                  <SelectTrigger id="dq-size" className="w-full">
                    <SelectValue placeholder="Select company size" />
                  </SelectTrigger>
                  <SelectContent>
                    {COMPANY_SIZES.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.value} employees
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-goal">
                  What do you want Kortix to do?{' '}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  id="dq-goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="e.g. automate our inbound support triage"
                  rows={2}
                  className="resize-none"
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <DialogFooter variant="bar" className="justify-between">
              <span className="text-xs text-muted-foreground">
                No spam — a human replies.
              </span>
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>
                    Continue
                    <ArrowRight />
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : (
        // Disqualified → self-serve. Confirm capture, then frame self-serve as
        // the faster path (not a rejection).
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[420px]">
          <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
            <DialogTitle>You can start right now</DialogTitle>
            <DialogDescription>
              No call needed — Kortix is self-serve, so you can dive straight in.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-6 py-5">
            <InfoBanner tone="success" icon={Check} title="Request received">
              We&apos;ve saved your details and we&apos;ll be in touch if it&apos;s a fit.
            </InfoBanner>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Spin up your first agent in minutes — most teams your size are up
              and running the same day. If you hit a wall, we&apos;re one email away.
            </p>
          </div>

          <DialogFooter variant="bar">
            <Button asChild variant="ghost">
              <a href={`mailto:${CONTACT_EMAIL}`}>
                <Mail />
                Email us
              </a>
            </Button>
            <Button asChild>
              <a href={selfServeHref}>
                Launch Kortix
                <ArrowRight />
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
