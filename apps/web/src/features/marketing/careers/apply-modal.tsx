'use client';

import { Button } from '@/components/ui/button';
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
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { applyForm } from './content';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The same lead pipeline "Book your demo" uses: `POST /api/demo-request`
 *  persists the whole submission verbatim into `public.contact_forms` and fires
 *  the internal notification email. Applications land exactly where demo
 *  requests already land — no second inbox, no ATS.
 *
 *  The endpoint takes JSON only, so there is no attachment path: the form asks
 *  for a LINK to a CV or portfolio instead. `goal` is composed rather than raw
 *  because it is the field the notification email renders. */
const LEAD_ENDPOINT = '/api/demo-request';
const SOURCE = 'careers-application';

export function ApplyModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const [step, setStep] = useState<'form' | 'done'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [area, setArea] = useState<string | null>(null);
  const [owned, setOwned] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep('form');
      setError(null);
    }
  }, [open]);

  const submit = useCallback(async () => {
    const fail = (message: string) => {
      setError(message);
      errorToast(message);
    };

    if (!EMAIL_RE.test(email.trim())) return fail(applyForm.errors.email);
    if (!area) return fail(applyForm.errors.area);
    if (!owned.trim()) return fail(applyForm.errors.owned);
    setError(null);

    setSubmitting(true);
    try {
      await fetch(LEAD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          company_name: `Careers — ${area}`,
          /* Rendered as "Goal" in the internal notification email, so the one
             question that matters is readable without opening the database. */
          goal: [
            `Opening: ${area}`,
            `Owned: ${owned.trim()}`,
            `Link: ${link.trim() || 'none given'}`,
          ].join('\n'),
          /* Kept as their own keys too — the row in contact_forms stores the
             body verbatim. */
          opening: area,
          owned: owned.trim(),
          link: link.trim(),
          qualified: false,
          source: SOURCE,
        }),
      });
    } catch {
      errorToast('Could not send your application', {
        description: 'Write to marko@kortix.com instead.',
      });
      return;
    } finally {
      setSubmitting(false);
    }
    setStep('done');
  }, [area, email, link, name, owned]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {step === 'form' ? (
        <ModalContent variant="base" className="gap-0 space-y-0 overflow-hidden p-0 sm:max-w-[440px]">
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <ModalHeader className="pb-4">
              <ModalTitle>{applyForm.title}</ModalTitle>
              <ModalDescription>{applyForm.description}</ModalDescription>
            </ModalHeader>

            <ModalBody className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="apply-name">
                  {applyForm.nameLabel} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="apply-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={applyForm.namePlaceholder}
                  autoComplete="name"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="apply-email">
                  {applyForm.emailLabel} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="apply-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={applyForm.emailPlaceholder}
                  autoComplete="email"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="apply-area">
                  {applyForm.areaLabel} <span className="text-destructive">*</span>
                </Label>
                <Select value={area ?? undefined} onValueChange={setArea}>
                  <SelectTrigger
                    id="apply-area"
                    className="border-border bg-input text-foreground w-full"
                  >
                    <SelectValue placeholder={applyForm.areaPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {applyForm.areaOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="apply-owned">
                  {applyForm.ownedLabel} <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="apply-owned"
                  value={owned}
                  onChange={(e) => setOwned(e.target.value)}
                  placeholder={applyForm.ownedPlaceholder}
                  rows={4}
                  className="resize-none"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="apply-link">{applyForm.linkLabel}</Label>
                <Input
                  id="apply-link"
                  type="url"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder={applyForm.linkPlaceholder}
                  inputMode="url"
                />
              </div>

              {error && <p className="text-destructive text-sm">{error}</p>}
            </ModalBody>

            <ModalFooter className="px-4 pb-4">
              <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
                {submitting ? (
                  <>
                    <Loading className="animate-spin" />
                    {applyForm.submitting}
                  </>
                ) : (
                  applyForm.submit
                )}
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      ) : (
        <ModalContent variant="base" className="gap-0 overflow-hidden p-0 sm:max-w-[440px]">
          <ModalHeader className="pb-4">
            <ModalTitle>{applyForm.doneTitle}</ModalTitle>
            <ModalDescription>{applyForm.doneBody}</ModalDescription>
          </ModalHeader>
          <ModalFooter className="px-4 pb-4">
            <Button onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
              {applyForm.doneCta}
            </Button>
          </ModalFooter>
        </ModalContent>
      )}
    </Modal>
  );
}
