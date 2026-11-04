'use client';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import Cal, { getCalApi } from '@calcom/embed-react';
import {
  ArrowRightIcon as ArrowRight,
  CalendarBlankIcon as CalendarBlank,
  CheckIcon as Check,
  EnvelopeIcon as Mail,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@kortix/ui';
import { KortixLogo } from '@kortix/ui/kortix-logo';
import { Close } from '@kortix/ui/icons';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';

import { isWorkEmail } from '@/lib/personal-email';

import { Button } from '@kortix/ui/button';
import { Field, FieldGroup, FieldLabel } from '@kortix/ui/field';
import { InfoBanner } from '@kortix/ui/info-banner';
import { Input, inputInvalidClasses } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast } from '@kortix/ui/toast';
import Link from 'next/link';

import {
  formatBookedSlot,
  subscribeBookingSuccess,
  type CalBooking,
  type CalEventApi,
} from './demo-booking';

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

/** The fields the form checks, in the order they appear (the first error takes focus). */
type FieldKey = 'name' | 'company' | 'email' | 'size';
const FIELD_ID: Record<FieldKey, string> = {
  name: 'dq-name',
  company: 'dq-company',
  email: 'dq-email',
  size: 'dq-size',
};
type FieldErrors = Partial<Record<FieldKey, string>>;

// Ticket perforation: each half of the confirmation is cut by an 11px
// half-circle on both edges where the halves meet, so the overlay shows
// through the notches.
const notch = (y: '0' | '100%') =>
  [
    `radial-gradient(circle 11px at 0 ${y}, transparent 98%, #000) left / 51% 100% no-repeat`,
    `radial-gradient(circle 11px at 100% ${y}, transparent 98%, #000) right / 51% 100% no-repeat`,
  ].join(', ');
const TICKET_TOP = { mask: notch('100%') };
const TICKET_BOTTOM = { mask: notch('0') };

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

/**
 * The demo's identity and progress, shown above every step so the modal reads
 * as one flow: the Kortix tile, the meeting name, the close button, and, while
 * the person is still booking, the two steps (Your details, Pick a time).
 */
function DemoHeader({ step }: { step?: 0 | 1 }) {
  const t = useTranslations('demoBooking');
  const steps = [t('stepDetails'), t('stepTime')];
  return (
    <div className="flex flex-col gap-5 px-6 pt-5">
      <div className="flex items-center gap-2.5">
        <span className="bg-background text-foreground ring-border flex size-7 shrink-0 items-center justify-center rounded-md ring-1 ring-inset">
          <KortixLogo variant="icon" size={14} />
        </span>
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
          {t('meetingTitle')}
        </span>
        <ModalClose asChild>
          <Button variant="ghost" size="icon-base" className="-mr-2 shrink-0">
            <Close className="size-4 stroke-1" />
            <span className="sr-only">{t('close')}</span>
          </Button>
        </ModalClose>
      </div>
      {step !== undefined && (
        <ol className="grid grid-cols-2 gap-2">
          {steps.map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? 'step' : undefined}
              className="flex min-w-0 flex-col gap-2"
            >
              <span
                aria-hidden
                className={cn('h-0.5 rounded-full', i <= step ? 'bg-foreground' : 'bg-border')}
              />
              <span
                className={cn(
                  'flex min-w-0 items-center gap-1.5 text-xs',
                  i <= step ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {i < step ? (
                  <Check aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <span aria-hidden className="tabular-nums">
                    {i + 1}
                  </span>
                )}
                <span className="truncate">{label}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One field's error line, read by the input through `aria-describedby`. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-destructive text-xs text-pretty wrap-anywhere">
      {message}
    </p>
  );
}

export function DemoQualifierModal({
  open,
  onOpenChange,
  calLink,
  calNamespace,
  source = 'contact',
  title,
  description,
  defaultName = '',
  defaultEmail = '',
  onBookingSuccessful,
}: DemoQualifierModalProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const t = useTranslations('demoBooking');
  const locale = useLocale();
  const [step, setStep] = useState<'form' | 'cal' | 'booked' | 'received'>('form');
  const [booking, setBooking] = useState<CalBooking | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [company, setCompany] = useState('');
  const [size, setSize] = useState<CompanySize | null>(null);
  const [goal, setGoal] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const companySizes = useMemo(() => companySizesForEmail(email), [email]);
  const slot = useMemo(() => booking && formatBookedSlot(booking, locale), [booking, locale]);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setStep('form');
      setBooking(null);
      setErrors({});
    }
  }

  const [prevDefaultName, setPrevDefaultName] = useState(defaultName);
  if (defaultName !== prevDefaultName) {
    setPrevDefaultName(defaultName);
    if (defaultName) setName((n) => n || defaultName);
  }
  const [prevDefaultEmail, setPrevDefaultEmail] = useState(defaultEmail);
  if (defaultEmail !== prevDefaultEmail) {
    setPrevDefaultEmail(defaultEmail);
    if (defaultEmail) setEmail((e) => e || defaultEmail);
  }

  useEffect(() => {
    // Only touch the Cal.com embed API once the modal is actually open. This
    // keeps the modal cheap to mount app-wide (it lives in the root layout so
    // every enterprise CTA can open it) — the embed script loads lazily on
    // open, not on every page paint.
    if (!open) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void getCalApi({ namespace: calNamespace }).then((cal) => {
      if (cancelled) return;
      cal('ui', { hideEventTypeDetails: false, layout: 'month_view' });
      // A booking swaps the embed for our confirmation. The modal stays open
      // until the person closes it.
      unsubscribe = subscribeBookingSuccess(cal as unknown as CalEventApi, (b) => {
        setBooking(b);
        setStep('booked');
        onBookingSuccessful?.();
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [open, calNamespace, onBookingSuccessful]);

  /** Clear one field's error as soon as the person edits that field. */
  const clearError = (key: FieldKey) =>
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });

  const submit = useCallback(async () => {
    // Every problem shows at once, under its own field, and the first one
    // takes focus. The form sets `noValidate`, so the browser's own bubbles
    // never cover these.
    const found: FieldErrors = {};
    if (!name.trim()) found.name = t('errorName');
    if (!company.trim()) found.company = t('errorCompany');
    if (!EMAIL_RE.test(email.trim())) found.email = t('errorEmail');
    if (!size) found.size = t('errorSize');
    setErrors(found);
    const first = (Object.keys(FIELD_ID) as FieldKey[]).find((k) => found[k]);
    if (first || !size) {
      if (first) document.getElementById(FIELD_ID[first])?.focus();
      return;
    }
    const qualified = sizeQualifies(size, email);

    setSubmitting(true);
    try {
      const response = await fetch('/api/demo-request', {
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
      if (!response.ok) throw new Error(`Demo request failed: ${response.status}`);
      setStep(qualified ? 'cal' : 'received');
    } catch {
      errorToast(tI18nHardcoded.raw('i18nComplete.text5859e6efd762'));
    } finally {
      setSubmitting(false);
    }
  }, [email, company, size, name, goal, source, t, tI18nHardcoded]);

  const calConfig: Record<string, string> = { layout: 'month_view' };
  if (name.trim()) calConfig.name = name.trim();
  if (email.trim()) calConfig.email = email.trim();
  if (company.trim()) calConfig[CAL_FIELD_COMPANY_NAME] = company.trim();
  if (size) calConfig[CAL_FIELD_COMPANY_SIZE] = size;
  if (goal.trim()) calConfig.notes = `Goal: ${goal.trim()}`;

  /** The props that tie an input to its error line. */
  const invalidProps = (key: FieldKey) =>
    errors[key]
      ? { 'aria-invalid': true as const, 'aria-describedby': `${FIELD_ID[key]}-error` }
      : {};

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {step === 'cal' ? (
        <ModalContent
          showCloseButton={false}
          variant="base"
          className="gap-0 space-y-0 overflow-hidden p-0 lg:max-w-lg"
        >
          <ModalTitle className="sr-only">{t('meetingTitle')}</ModalTitle>
          <ModalDescription className="sr-only">{t('stepTime')}</ModalDescription>
          <DemoHeader step={1} />
          <div className="mt-4 h-[min(780px,82vh)] overflow-y-auto">
            <Cal
              namespace={calNamespace}
              calLink={calLink}
              style={{ width: '100%', height: '100%' }}
              config={calConfig}
            />
          </div>
        </ModalContent>
      ) : step === 'booked' ? (
        <ModalContent
          showCloseButton={false}
          variant="transparent"
          // A confirmation must not vanish on a stray click or a focus shift.
          // Only Done, the close button and Escape dismiss it.
          closeOnOutsideClick={false}
          className="gap-0 space-y-0 border-0 p-0 shadow-none drop-shadow-xl lg:max-w-sm"
        >
          <div className="bg-background rounded-t-xl pb-8" style={TICKET_TOP}>
            <div className="flex items-center justify-between pt-4 pr-3 pl-5">
              <div className="flex items-center gap-1.5">
                <SolidCheckIcon className="text-kortix-green size-4" />
                <ModalTitle className="text-foreground text-xs font-medium">
                  {t('bookedLabel')}
                </ModalTitle>
              </div>
              <ModalClose asChild>
                <Button variant="ghost" size="icon-base">
                  <Close className="size-4 stroke-1" />
                  <span className="sr-only">{t('close')}</span>
                </Button>
              </ModalClose>
            </div>

            <div className="flex items-center gap-4 px-5 pt-3">
              {slot && (
                <div className="bg-muted flex w-16 shrink-0 flex-col items-center justify-center rounded-md py-2">
                  <span className="text-muted-foreground text-xs font-medium">{slot.month}</span>
                  <span className="text-foreground text-2xl font-semibold tracking-tight tabular-nums">
                    {slot.day}
                  </span>
                  <span className="text-muted-foreground text-xs">{slot.weekday}</span>
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-foreground truncate text-xl font-semibold">
                  {t('meetingTitle')}
                </span>
                {slot && (
                  <span className="text-foreground pt-0.5 text-sm tabular-nums">
                    {slot.time} {slot.zone}
                  </span>
                )}
                {slot && (
                  <span className="text-muted-foreground text-xs">
                    {t('bookedMeta', { minutes: slot.minutes })}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="bg-background relative -mt-px rounded-b-xl" style={TICKET_BOTTOM}>
            <div className="border-border absolute inset-x-4 top-0 border-t-2 border-dashed" />
            <div className="flex flex-col gap-4 px-5 pt-6 pb-5">
              <ModalDescription asChild>
                <div className="flex flex-col gap-0.5 text-xs">
                  <span className="text-foreground font-medium">
                    {t('inviteSent', { email: email.trim() })}
                  </span>
                  <span className="text-muted-foreground">{t('reschedule')}</span>
                </div>
              </ModalDescription>
              <div className="flex flex-col items-center gap-2">
                <ModalClose asChild>
                  <Button size="lg" className="w-full">
                    {t('done')}
                  </Button>
                </ModalClose>
                {booking?.uid && (
                  <Button asChild variant="text" size="xs" className="text-xs">
                    <a
                      href={`https://cal.com/booking/${encodeURIComponent(booking.uid)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <CalendarBlank />
                      {t('addToCalendar')}
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </div>
        </ModalContent>
      ) : step === 'form' ? (
        <ModalContent
          showCloseButton={false}
          variant="base"
          className="gap-0 space-y-0 p-0 lg:h-auto lg:max-w-lg"
        >
          <form
            noValidate
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <DemoHeader step={0} />

            <ModalHeader className="gap-1.5 px-6 pt-6">
              <ModalTitle className="text-lg font-medium text-balance">
                {title ?? t('formTitle')}
              </ModalTitle>
              <ModalDescription className="text-pretty">
                {description ?? t('formDescription')}
              </ModalDescription>
            </ModalHeader>

            <ModalBody className="px-6 pt-6 pb-0">
              <FieldGroup className="gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field className="gap-1.5" data-invalid={errors.name ? true : undefined}>
                    <FieldLabel htmlFor={FIELD_ID.name}>
                      {tI18nHardcoded.raw('i18nComplete.textdcd1d5223f73')}
                    </FieldLabel>
                    <Input
                      id={FIELD_ID.name}
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        clearError('name');
                      }}
                      placeholder={tI18nHardcoded.raw(
                        'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderYourName7a7a05ae',
                      )}
                      autoComplete="name"
                      required
                      {...invalidProps('name')}
                    />
                    <FieldError id={`${FIELD_ID.name}-error`} message={errors.name} />
                  </Field>
                  <Field className="gap-1.5" data-invalid={errors.company ? true : undefined}>
                    <FieldLabel htmlFor={FIELD_ID.company}>
                      {tI18nHardcoded.raw(
                        'autoFeaturesContactDemoQualifierModalJsxTextCompanyName04d8fd10',
                      )}
                    </FieldLabel>
                    <Input
                      id={FIELD_ID.company}
                      value={company}
                      onChange={(e) => {
                        setCompany(e.target.value);
                        clearError('company');
                      }}
                      placeholder={tI18nHardcoded.raw(
                        'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderAcmeInc4c41f6f1',
                      )}
                      autoComplete="organization"
                      required
                      {...invalidProps('company')}
                    />
                    <FieldError id={`${FIELD_ID.company}-error`} message={errors.company} />
                  </Field>
                </div>

                <Field className="gap-1.5" data-invalid={errors.email ? true : undefined}>
                  <FieldLabel htmlFor={FIELD_ID.email}>
                    {tI18nHardcoded.raw(
                      'autoFeaturesContactDemoQualifierModalJsxTextWorkEmailc15a71d1',
                    )}
                  </FieldLabel>
                  <Input
                    id={FIELD_ID.email}
                    type="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      clearError('email');
                      if (!isWorkEmail(e.target.value)) setSize((s) => (s === '1-10' ? null : s));
                    }}
                    placeholder={tI18nHardcoded.raw(
                      'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderYouCompanyee6aa000',
                    )}
                    autoComplete="email"
                    required
                    {...invalidProps('email')}
                  />
                  <FieldError id={`${FIELD_ID.email}-error`} message={errors.email} />
                </Field>

                <Field className="gap-1.5" data-invalid={errors.size ? true : undefined}>
                  <FieldLabel htmlFor={FIELD_ID.size}>
                    {tI18nHardcoded.raw(
                      'autoFeaturesContactDemoQualifierModalJsxTextCompanySizee13e1fef',
                    )}
                  </FieldLabel>
                  <Select
                    value={size ?? undefined}
                    onValueChange={(v) => {
                      setSize(v as CompanySize);
                      clearError('size');
                    }}
                  >
                    <SelectTrigger
                      id={FIELD_ID.size}
                      variant="outline"
                      // The trigger shows the same invalid border and halo as the inputs beside it.
                      className={cn('h-9 w-full px-3 font-medium', inputInvalidClasses)}
                      {...invalidProps('size')}
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
                          {o.value} {tI18nHardcoded.raw('i18nComplete.textc49de3d265fb')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError id={`${FIELD_ID.size}-error`} message={errors.size} />
                </Field>

                <Field className="gap-1.5">
                  <FieldLabel htmlFor="dq-goal" className="gap-1.5">
                    {tI18nHardcoded.raw(
                      'autoFeaturesContactDemoQualifierModalJsxTextWhatDoYoud0acfddd',
                    )}
                    <span className="text-muted-foreground font-normal">
                      {tI18nHardcoded.raw('i18nComplete.text0059798b7f70')}
                    </span>
                  </FieldLabel>
                  <Textarea
                    id="dq-goal"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder={tI18nHardcoded.raw(
                      'autoFeaturesContactDemoQualifierModalJsxAttrPlaceholderEGcf1d0320',
                    )}
                    rows={3}
                    className="resize-none"
                  />
                </Field>
              </FieldGroup>
            </ModalBody>

            <div className="px-6 pt-6 pb-6">
              <Button
                type="submit"
                size="lg"
                disabled={submitting}
                aria-busy={submitting || undefined}
                className="group/cta w-full"
              >
                {submitting ? (
                  <>
                    <Loading />
                    {tI18nHardcoded.raw(
                      'autoFeaturesContactDemoQualifierModalJsxTextSendingb5b0a82a',
                    )}
                  </>
                ) : (
                  <>
                    {t('seeTimes')}
                    <ArrowRight className="transition-transform duration-(--duration-fast) ease-out group-hover/cta:translate-x-0.5 motion-reduce:transition-none" />
                  </>
                )}
              </Button>
            </div>
          </form>
        </ModalContent>
      ) : (
        <ModalContent
          showCloseButton={false}
          variant="base"
          className="gap-0 space-y-0 p-0 lg:h-auto lg:max-w-lg"
        >
          <DemoHeader />

          <ModalHeader className="gap-1.5 px-6 pt-6">
            <ModalTitle className="text-lg font-medium text-balance">
              {tI18nHardcoded.raw(
                'autoFeaturesContactDemoQualifierModalJsxTextRequestReceivedab5bf6e1',
              )}
            </ModalTitle>
            <ModalDescription className="text-pretty">
              {tI18nHardcoded.raw('autoFeaturesContactDemoQualifierModalJsxTextThanksWeVeafd780cd')}
            </ModalDescription>
          </ModalHeader>

          <div className="space-y-4 px-6 pt-6">
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
            <p className="text-muted-foreground text-sm text-pretty">
              {tI18nHardcoded.raw('autoFeaturesContactDemoQualifierModalJsxTextSpinUpYour0b48cac5')}
            </p>
          </div>

          <div className="flex flex-col gap-2 px-6 pt-6 pb-6">
            <Button size="lg" onClick={() => onOpenChange(false)} className="w-full">
              {tI18nHardcoded.raw('i18nComplete.text11a6767d5674')}
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link href={`mailto:${CONTACT_EMAIL}`}>
                <Mail />
                {tI18nHardcoded.raw('autoFeaturesContactDemoQualifierModalJsxTextEmailUs103301cb')}
              </Link>
            </Button>
          </div>
        </ModalContent>
      )}
    </Modal>
  );
}
