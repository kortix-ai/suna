'use client';

/**
 * Who the team works for.
 *
 * Domain and size share one screen because they are one thought. Both fields
 * are optional, so empty domain still Continues; a non-empty value must be a
 * valid http(s) link or hostname, or Continue shakes the input and stays put.
 */

import type { OnboardingCompanySize } from '@kortix/sdk';
import { GlobeIcon, UsersIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { RadioGroup } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

import { COMPANY_SIZES, isValidCompanyHttpLink } from '../onboarding-profile';
import { SelectionRow, StepShell } from '../step-shell';

export function CompanyStep({
  domain,
  size,
  onDomainChange,
  onSizeChange,
  onContinue,
  onSkip,
}: {
  domain: string;
  size: OnboardingCompanySize | null;
  onDomainChange: (v: string) => void;
  onSizeChange: (v: OnboardingCompanySize) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [domainInvalid, setDomainInvalid] = useState(false);

  const triggerDomainError = () => {
    // Drop then re-apply so the group shake restarts when Continue is pressed
    // again on the same bad value.
    setDomainInvalid(false);
    requestAnimationFrame(() => setDomainInvalid(true));
  };

  const handleContinue = () => {
    const trimmed = domain.trim();
    if (trimmed && !isValidCompanyHttpLink(trimmed)) {
      triggerDomainError();
      return;
    }
    setDomainInvalid(false);
    onContinue();
  };

  return (
    <StepShell
      title="Tell us about your company"
      description="Your agent uses the domain to research your own company. Nothing is shared publicly."
      primaryLabel="Continue"
      onPrimary={handleContinue}
      skipLabel="Skip survey"
      onSkip={onSkip}
    >
      {/* space-y-8: two separate questions on one screen need to read as two,
          not as a stacked form. */}
      <div className="space-y-8">
        <div className="space-y-3">
          <Label htmlFor="onboarding-company-domain">Company domain</Label>
          <InputGroup className={cn('h-11', domainInvalid && 'motion-safe:animate-shake')}>
            <InputGroupAddon>
              <GlobeIcon className="text-muted-foreground size-4" />
            </InputGroupAddon>
            <InputGroupInput
              id="onboarding-company-domain"
              inputMode="url"
              value={domain}
              onChange={(e) => {
                onDomainChange(e.target.value);
                if (domainInvalid) setDomainInvalid(false);
              }}
              onBlur={() => {
                const trimmed = domain.trim();
                if (trimmed && !isValidCompanyHttpLink(trimmed)) {
                  triggerDomainError();
                }
              }}
              placeholder="acme.com"
              autoComplete="organization"
              spellCheck={false}
              aria-invalid={domainInvalid || undefined}
              aria-describedby={domainInvalid ? 'onboarding-company-domain-error' : undefined}
              // Group owns the shake — a second one on Input would compound.
              className="aria-invalid:animate-none"
            />
          </InputGroup>
          {domainInvalid ? (
            <p
              id="onboarding-company-domain-error"
              className="text-destructive text-sm"
              role="alert"
            >
              Enter a valid link like acme.com or https://acme.com
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          <Label>Company size</Label>
          <RadioGroup
            value={size ?? ''}
            onValueChange={(nextSize) => onSizeChange(nextSize as OnboardingCompanySize)}
            aria-label="Company size"
            className="gap-2"
          >
            {COMPANY_SIZES.map((option, idx) => (
              <SelectionRow
                key={option}
                value={option}
                label={`${option} people`}
                leading={
                  <UsersIcon
                    className={cn(
                      'size-5 shrink-0',
                      idx === 0 && 'text-muted-foreground/20',
                      idx === 1 && 'text-muted-foreground/40',
                      idx === 2 && 'text-muted-foreground/60',
                      idx === 3 && 'text-muted-foreground/80',
                      idx === 4 && 'text-muted-foreground',
                    )}
                  />
                }
              />
            ))}
          </RadioGroup>
        </div>
      </div>
    </StepShell>
  );
}
