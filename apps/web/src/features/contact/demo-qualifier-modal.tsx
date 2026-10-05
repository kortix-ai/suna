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

import { KortixLogo } from '@/components/ui/kortix-logo';
import { Close } from '@/features/icon/icons/close';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';

import { isWorkEmail } from '@/lib/personal-email';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalClose,
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

// The Kortix logo tile is light in both themes.
const LOGO_TILE = 'bg-white text-black';

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

/** The demo's identity, shown above every step so the modal reads as one flow. */
function MeetingHeader({ meta }: { meta: string }) {
  const t = useTranslations('demoBooking');
  return (
    <div className="bg-sidebar border-border flex items-center gap-3 border-b px-5 py-4">
      <div className={`flex size-8 shrink-0 items-center justify-center rounded-sm ${LOGO_TILE}`}>
        <KortixLogo variant="icon" size={16} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground text-sm font-medium">{t('meetingTitle')}</span>
        <span className="text-muted-foreground truncate text-xs">{meta}</span>
      </div>
      <ModalClose asChild>
        <Button variant="ghost" size="icon-base" className="shrink-0">
          <Close className="size-4 stroke-1" />
          <span className="sr-only">{t('close')}</span>
        </Button>
      </ModalClose>
    </div>
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
  const [error, setError] = useState<string | null>(null);

  const companySizes = useMemo(() => companySizesForEmail(email), [email]);
  const slot = useMemo(() => booking && formatBookedSlot(booking, locale), [booking, locale]);

  useEffect(() => {
    if (size === '1-10' && !isWorkEmail(email)) setSize(null);
  }, [email, size]);

  useEffect(() => {
    if (open) {
      setStep('form');
      setBooking(null);
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
      errorToast(tI18nHardcoded.raw('i18nComplete.text5859e6efd762'), {
        description: tI18nHardcoded.raw('i18nComplete.text1a3ba76c2b52'),
      });
    } finally {
      setSubmitting(false);
    }

    setStep(qualified ? 'cal' : 'received');
  }, [email, company, size, name, goal, source, tI18nHardcoded]);

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
          variant="base"
          className="gap-0 space-y-0 overflow-hidden p-0 lg:max-w-lg"
        >
          <ModalTitle className="sr-only">{t('meetingTitle')}</ModalTitle>
          <MeetingHeader meta={t('stepTime')} />
          <div className="h-[min(780px,82vh)] overflow-y-auto">
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
          <div className="bg-background rounded-t-xl pb-7.5" style={TICKET_TOP}>
            <div className="flex items-center justify-between pt-4 pr-3 pl-5">
              <div className="flex items-center gap-1.5">
                <SolidCheckIcon className="text-kortix-green size-4" />
                <ModalTitle className="text-kortix-green text-xs font-medium">
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
                <div className="bg-muted flex h-19.5 w-17.5 shrink-0 flex-col items-center justify-center rounded-lg">
                  <span className="text-kortix-red text-[11px] leading-3.5 font-semibold tracking-[0.1em] uppercase">
                    {slot.month}
                  </span>
                  <span className="text-foreground text-[28px] leading-[30px] font-semibold tracking-[-0.03em] tabular-nums">
                    {slot.day}
                  </span>
                  <span className="text-muted-foreground text-[11px] leading-3.5 font-medium">
                    {slot.weekday}
                  </span>
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-foreground truncate text-xl leading-6 font-semibold tracking-[-0.015em]">
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
            <div className="border-foreground/15 absolute inset-x-4.5 top-0 border-t-2 border-dashed" />
            <div className="flex flex-col gap-4 px-5 pt-6 pb-5">
              <ModalDescription asChild>
                <div className="flex flex-col gap-0.5 text-xs leading-5">
                  <span className="text-foreground font-medium">
                    {t('inviteSent', { email: email.trim() })}
                  </span>
                  <span className="text-muted-foreground">{t('reschedule')}</span>
                </div>
              </ModalDescription>
              <div className="flex flex-col items-center gap-2.5">
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
          className="gap-0 space-y-0 overflow-hidden p-0 lg:max-w-lg"
        >
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <MeetingHeader meta={t('stepDetails')} />

            <ModalHeader className="px-6 pt-5 pb-0">
              <ModalTitle className="text-xl font-semibold tracking-tight">
                {title ?? t('formTitle')}
              </ModalTitle>
              <ModalDescription>{description ?? t('formDescription')}</ModalDescription>
            </ModalHeader>

            <ModalBody className="space-y-4 px-6 pt-5 pb-5">
              <div className="flex gap-3">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="dq-name">
                    {tI18nHardcoded.raw('i18nComplete.textdcd1d5223f73')}
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
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="dq-company">
                    {tI18nHardcoded.raw(
                      'autoFeaturesContactDemoQualifierModalJsxTextCompanyName04d8fd10',
                    )}
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
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-email">
                  {tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxTextWorkEmailc15a71d1',
                  )}
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
                <Label htmlFor="dq-size">
                  {tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxTextCompanySizee13e1fef',
                  )}
                </Label>
                <Select value={size ?? undefined} onValueChange={(v) => setSize(v as CompanySize)}>
                  <SelectTrigger
                    id="dq-size"
                    variant="outline"
                    className="h-9 w-full px-3 font-medium"
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
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dq-goal">
                  {tI18nHardcoded.raw(
                    'autoFeaturesContactDemoQualifierModalJsxTextWhatDoYoud0acfddd',
                  )}{' '}
                  <span className="text-muted-foreground font-normal">
                    {tI18nHardcoded.raw('i18nComplete.text0059798b7f70')}
                  </span>
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

            <div className="px-6 pb-6">
              <Button type="submit" disabled={submitting} className="group/cta w-full">
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
        <ModalContent variant="base" className="gap-0 overflow-hidden p-0 lg:max-w-lg">
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
              {tI18nHardcoded.raw('i18nComplete.text11a6767d5674')}
            </Button>
          </ModalFooter>
        </ModalContent>
      )}
    </Modal>
  );
}
