'use client';

import Cal, { getCalApi } from '@calcom/embed-react';
import { Check, Mail } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { isWorkEmail } from '@/lib/personal-email';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorToast } from '@/components/ui/toast';
import Link from 'next/link';

const CAL_FIELD_COMPANY_SIZE = 'Company_size';
const CAL_FIELD_COMPANY_NAME = 'Company_name';

const CONTACT_EMAIL = 'hey@kortix.ai';

type CompanySize = '1-10' | '11-50' | '51-200' | '201-1000' | '1000+';

const QUALIFYING_COMPANY_SIZES: { value: CompanySize; qualifies: boolean }[] = [
  { value: '11-50', qualifies: true },
  { value: '51-200', qualifies: true },
  { value: '201-1000', qualifies: true },
  { value: '1000+', qualifies: true },
];

const SMALL_COMPANY_SIZE = { value: '1-10' as const, qualifies: false };

const companySizesForEmail = (email: string) =>
  isWorkEmail(email) ? [SMALL_COMPANY_SIZE, ...QUALIFYING_COMPANY_SIZES] : QUALIFYING_COMPANY_SIZES;

const sizeQualifies = (s: CompanySize, email: string) =>
  companySizesForEmail(email).find((o) => o.value === s)?.qualifies ?? false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DemoQualifierModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calLink: string;
  calNamespace: string;
  source?: string;
  title?: string;
  description?: string;
  defaultName?: string;
  defaultEmail?: string;
  onBookingSuccessful?: () => void;
}

export function DemoQualifierModal({
  open,
  onOpenChange,
  calLink,
  calNamespace,
  source = 'contact',
  title = 'Book your demo',
  description = "A couple of quick details so we can tailor the session — or point you to self-serve if that's faster.",
  defaultName = '',
  defaultEmail = '',
  onBookingSuccessful,
}: DemoQualifierModalProps) {
  const [step, setStep] = useState<'form' | 'cal' | 'received'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [company, setCompany] = useState('');
  const [size, setSize] = useState<CompanySize | null>(null);
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const companySizes = useMemo(() => companySizesForEmail(email), [email]);

  useEffect(() => {
    if (size === '1-10' && !isWorkEmail(email)) setSize(null);
  }, [email, size]);

  useEffect(() => {
    if (open) {
      setStep('form');
      setError(null);
    }
  }, [open]);

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
        callback: () => {
          onBookingSuccessful?.();
          window.setTimeout(() => onOpenChange(false), 1500);
        },
      });
    })();
  }, [calNamespace, onOpenChange, onBookingSuccessful]);

  const submit = useCallback(async () => {
    if (!EMAIL_RE.test(email.trim())) {
      const message = 'Enter a valid work email so we can reach you.';
      setError(message);
      errorToast(message);
      return;
    }
    if (!company.trim()) {
      const message = 'Tell us your company name.';
      setError(message);
      errorToast(message);
      return;
    }
    if (!size) {
      const message = 'Pick your company size.';
      setError(message);
      errorToast(message);
      return;
    }
    setError(null);
    const qualified = sizeQualifies(size, email);

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
      errorToast('Could not save demo request', {
        description: "We'll still route you to the next step.",
      });
    } finally {
      setSubmitting(false);
    }

    setStep(qualified ? 'cal' : 'received');
  }, [email, size, name, company, goal, source]);

  const calConfig: Record<string, string> = { layout: 'month_view' };
  if (name.trim()) calConfig.name = name.trim();
  if (email.trim()) calConfig.email = email.trim();
  if (company.trim()) calConfig[CAL_FIELD_COMPANY_NAME] = company.trim();
  if (size) calConfig[CAL_FIELD_COMPANY_SIZE] = size;
  if (goal.trim()) calConfig.notes = `Goal: ${goal.trim()}`;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {step === 'cal' ? (
        <ModalContent
          showCloseButton={false}
          variant="transparent"
          className="max-w-[min(980px,95vw)] gap-0 overflow-hidden rounded-2xl border-none bg-transparent p-0 shadow-none lg:h-auto"
        >
          <ModalTitle className="sr-only">{title}</ModalTitle>
          <div className="h-[82vh] max-h-[780px] overflow-hidden rounded-2xl">
            <Cal
              namespace={calNamespace}
              calLink={calLink}
              style={{ width: '100%', height: '100%' }}
              config={calConfig}
            />
          </div>
        </ModalContent>
      ) : step === 'form' ? (
        <ModalContent
          variant="base"
          className="gap-0 space-y-0 overflow-hidden p-0 sm:max-w-[420px]"
        >
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <ModalHeader className="pb-4">
              <ModalTitle>{title}</ModalTitle>
              <ModalDescription>{description}</ModalDescription>
            </ModalHeader>

            <ModalBody className="space-y-4">
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
                <Label htmlFor="dq-company">
                  Company name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="dq-company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Acme Inc."
                  autoComplete="organization"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-size">
                  Company size <span className="text-destructive">*</span>
                </Label>
                <Select value={size ?? undefined} onValueChange={(v) => setSize(v as CompanySize)}>
                  <SelectTrigger
                    id="dq-size"
                    className="border-border bg-input text-foreground w-full"
                  >
                    <SelectValue placeholder="Select company size" />
                  </SelectTrigger>
                  <SelectContent>
                    {companySizes.map((o) => (
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
                  <span className="text-muted-foreground font-normal">(optional)</span>
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

              {error && <p className="text-destructive text-sm">{error}</p>}
            </ModalBody>

            <ModalFooter className="justify-between px-4 pb-4 sm:justify-between">
              <span className="text-muted-foreground text-xs">No spam — a human replies.</span>
              <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
                {submitting ? (
                  <>
                    <Loading className="animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>Continue</>
                )}
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      ) : (
        <ModalContent variant="base" className="gap-0 overflow-hidden p-0 sm:max-w-[420px]">
          <ModalHeader className="border-border/60 border-b px-6 pt-6 pb-4">
            <ModalTitle>Request received</ModalTitle>
            <ModalDescription>Thanks — we&apos;ve got your details.</ModalDescription>
          </ModalHeader>

          <div className="space-y-4 px-6 py-5">
            <InfoBanner tone="success" icon={Check} title="We'll be in touch">
              Kortix is built for companies — we&apos;ll reach out if it&apos;s a fit.
            </InfoBanner>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Spin up your first agent in minutes — most teams your size are up and running the same
              day. If you hit a wall, we&apos;re one email away.
            </p>
          </div>

          <ModalFooter className="sm:justify-between">
            <Button asChild variant="ghost" className="w-full sm:w-auto">
              <Link href={`mailto:${CONTACT_EMAIL}`}>
                <Mail />
                Email us
              </Link>
            </Button>
            <Button onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
              Done
            </Button>
          </ModalFooter>
        </ModalContent>
      )}
    </Modal>
  );
}
