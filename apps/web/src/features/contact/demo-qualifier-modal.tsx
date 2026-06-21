'use client';

import Cal, { getCalApi } from '@calcom/embed-react';
import { Check, Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
                  placeholder={tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderYourName7a7a05ae',
                  )}
                  autoComplete="name"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-email">
                  {tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxTextWorkEmailc15a71d1',
                  )}
                  <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="dq-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderYouCompanyee6aa000',
                  )}
                  autoComplete="email"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-company">
                  {tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxTextCompanyName04d8fd10',
                  )}
                  <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="dq-company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder={tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderAcmeInc4c41f6f1',
                  )}
                  autoComplete="organization"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-size">
                  {tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxTextCompanySizee13e1fef',
                  )}
                  <span className="text-destructive">*</span>
                </Label>
                <Select value={size ?? undefined} onValueChange={(v) => setSize(v as CompanySize)}>
                  <SelectTrigger
                    id="dq-size"
                    className="border-border bg-input text-foreground w-full"
                  >
                    <SelectValue
                      placeholder={tI18nHardcoded.raw(
                        'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderSelectCompanya2ad2a30',
                      )}
                    />
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
                  {tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxTextWhatDoYoud0acfddd',
                  )}{' '}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  id="dq-goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder={tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderEGcf1d0320',
                  )}
                  rows={2}
                  className="resize-none"
                />
              </div>

              {error && <p className="text-destructive text-sm">{error}</p>}
            </ModalBody>

            <ModalFooter className="justify-between px-4 pb-4 sm:justify-between">
              <span className="text-muted-foreground text-xs">
                {tI18nHardcoded.raw('autoFeaturesContactDemoQualifierModalJsxTextNoSpamAd06b8b00')}
              </span>
              <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
                {submitting ? (
                  <>
                    <Loading className="animate-spin" />
                    {tI18nHardcoded.raw(
                      'autoFeaturesContactDemoQualifierModalJsxTextSendingb5b0a82a',
                    )}
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
            <ModalTitle>
              {tI18nHardcoded.raw(
                'autoFeaturesContactDemoQualifierModalJsxTextRequestReceivedab5bf6e1',
              )}
            </ModalTitle>
            <ModalDescription>
              {tI18nHardcoded.raw('autoFeaturesContactDemoQualifierModalJsxTextThanksWeVeafd780cd')}
            </ModalDescription>
          </ModalHeader>

          <div className="space-y-4 px-6 py-5">
            <InfoBanner
              tone="success"
              icon={Check}
              title={tI18nHardcoded.raw(
                'autoFeaturesContactDemoQualifierModalJsxAttrTitleWeLle3d686d7',
              )}
            >
              {tI18nHardcoded.raw(
                'autoFeaturesContactDemoQualifierModalJsxTextKortixIsBuilt9d7721e7',
              )}
            </InfoBanner>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {tI18nHardcoded.raw('autoFeaturesContactDemoQualifierModalJsxTextSpinUpYour0b48cac5')}
            </p>
          </div>

          <ModalFooter className="sm:justify-between">
            <Button asChild variant="ghost" className="w-full sm:w-auto">
              <Link href={`mailto:${CONTACT_EMAIL}`}>
                <Mail />
                {tI18nHardcoded.raw('autoFeaturesContactDemoQualifierModalJsxTextEmailUs103301cb')}
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
