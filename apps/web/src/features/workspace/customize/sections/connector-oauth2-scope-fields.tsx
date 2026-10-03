'use client';

import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useTranslations } from '@/i18n/use-translations';
import type { OAuth2CredentialForm } from './connector-oauth2';

export function OAuth2ScopeFields({
  value,
  onChange,
  idPrefix,
  scopePlaceholder,
}: {
  value: Pick<OAuth2CredentialForm, 'scopes' | 'resource' | 'audience'>;
  onChange: (key: 'scopes' | 'resource' | 'audience', value: string) => void;
  idPrefix: string;
  scopePlaceholder: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={id('scopes')}>{tI18nComplete.raw('text0d5644ff52ce')}</FieldLabel>
        <Input
          id={id('scopes')}
          value={value.scopes}
          onChange={(event) => onChange('scopes', event.target.value)}
          placeholder={scopePlaceholder}
          variant="popover"
        />
        <FieldDescription>{tI18nComplete.raw('textda4365b5d2bf')}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={id('resource')}>{tI18nComplete.raw('texteb7a842ff958')}</FieldLabel>
        <Input
          id={id('resource')}
          value={value.resource}
          onChange={(event) => onChange('resource', event.target.value)}
          placeholder={tI18nComplete.raw('text59be71333c96')}
          variant="popover"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id('audience')}>{tI18nComplete.raw('text545c02357695')}</FieldLabel>
        <Input
          id={id('audience')}
          value={value.audience}
          onChange={(event) => onChange('audience', event.target.value)}
          placeholder={tI18nComplete.raw('text59be71333c96')}
          variant="popover"
        />
      </Field>
    </>
  );
}
