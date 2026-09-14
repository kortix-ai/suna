'use client';

/**
 * Who the team works for.
 *
 * Just the company domain. Company size used to be a manual multi-choice
 * field here, but nothing in this codebase can derive it server-side (no
 * Clearbit-style enrichment source exists), so asking the user to hand-pick a
 * bucket bought nothing — it's gone rather than faked. The field is optional,
 * so empty domain still Continues; a non-empty value must be a valid http(s)
 * link or hostname, or Continue shakes the input and stays put.
 */

import { GlobeIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { isValidCompanyHttpLink } from '../onboarding-profile';
import { StepShell } from '../step-shell';

export function CompanyStep({
  domain,
  onDomainChange,
  onContinue,
  onSkip,
}: {
  domain: string;
  onDomainChange: (v: string) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('projectOnboarding.company');
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
      title={t('title')}
      description={t('description')}
      primaryLabel={t('continue')}
      onPrimary={handleContinue}
      skipLabel={t('skipSurvey')}
      onSkip={onSkip}
    >
      <div className="space-y-3">
        <Label htmlFor="onboarding-company-domain">{t('domain')}</Label>
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
            placeholder={tI18nComplete.raw('text1194228da8fd')}
            autoComplete="organization"
            spellCheck={false}
            aria-invalid={domainInvalid || undefined}
            aria-describedby={domainInvalid ? 'onboarding-company-domain-error' : undefined}
            // Group owns the shake — a second one on Input would compound.
            className="aria-invalid:animate-none"
          />
        </InputGroup>
        {domainInvalid ? (
          <p id="onboarding-company-domain-error" className="text-destructive text-sm" role="alert">
            {t('invalidDomain')}
          </p>
        ) : null}
      </div>
    </StepShell>
  );
}
