'use client';

import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useTranslations } from '@/i18n/use-translations';
import type { OAuth2ApplicationForm } from './connector-oauth2';

export function OAuth2ApplicationFields({
  value,
  onChange,
  idPrefix,
}: {
  value: OAuth2ApplicationForm;
  onChange: (value: OAuth2ApplicationForm) => void;
  idPrefix: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const set = <K extends keyof OAuth2ApplicationForm>(key: K, next: OAuth2ApplicationForm[K]) =>
    onChange({ ...value, [key]: next });
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <FieldGroup className="grid gap-3 sm:grid-cols-2">
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={id('discovery-url')}>
          {tI18nComplete.raw('texte62bef86ebd4')}
        </FieldLabel>
        <Input
          id={id('discovery-url')}
          type="url"
          value={value.discoveryUrl}
          onChange={(event) => set('discoveryUrl', event.target.value)}
          placeholder="https://identity.example.com/.well-known/openid-configuration"
          variant="popover"
        />
        <FieldDescription>{tI18nComplete.raw('text2fe1b45a5654')}</FieldDescription>
      </Field>
      {value.grant === 'authorization_code' && (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={id('authorization-url')}>
            {tI18nComplete.raw('textc70b5f2b670e')}
          </FieldLabel>
          <Input
            id={id('authorization-url')}
            type="url"
            value={value.authorizationUrl}
            onChange={(event) => set('authorizationUrl', event.target.value)}
            placeholder="https://identity.example.com/oauth2/authorize"
            variant="popover"
          />
        </Field>
      )}
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={id('token-url')}>{tI18nComplete.raw('text431e0036cba3')}</FieldLabel>
        <Input
          id={id('token-url')}
          type="url"
          value={value.tokenUrl}
          onChange={(event) => set('tokenUrl', event.target.value)}
          placeholder="https://identity.example.com/oauth2/token"
          variant="popover"
        />
      </Field>
      {value.grant === 'device_authorization' && (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={id('device-url')}>
            {tI18nComplete.raw('text1ffa9ae5b248')}
          </FieldLabel>
          <Input
            id={id('device-url')}
            type="url"
            value={value.deviceAuthorizationUrl}
            onChange={(event) => set('deviceAuthorizationUrl', event.target.value)}
            placeholder="https://identity.example.com/oauth2/device"
            variant="popover"
          />
        </Field>
      )}
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={id('revocation-url')}>
          {tI18nComplete.raw('texta6cc6ed3f841')}
        </FieldLabel>
        <Input
          id={id('revocation-url')}
          type="url"
          value={value.revocationUrl}
          onChange={(event) => set('revocationUrl', event.target.value)}
          placeholder="https://identity.example.com/oauth2/revoke"
          variant="popover"
        />
        <FieldDescription>{tI18nComplete.raw('text1458e20a1642')}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={id('client-id')}>{tI18nComplete.raw('text8726db013948')}</FieldLabel>
        <Input
          id={id('client-id')}
          value={value.clientId}
          onChange={(event) => set('clientId', event.target.value)}
          variant="popover"
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id('auth-method')}>{tI18nComplete.raw('textb5037fbea489')}</FieldLabel>
        <Select
          value={value.authMethod}
          onValueChange={(next) => set('authMethod', next as OAuth2ApplicationForm['authMethod'])}
        >
          <SelectTrigger id={id('auth-method')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{tI18nComplete.raw('text3a9be266e664')}</SelectItem>
            <SelectItem value="client_secret_basic">
              {tI18nComplete.raw('textedb912f176d8')}
            </SelectItem>
            <SelectItem value="client_secret_post">
              {tI18nComplete.raw('textfd4daecd5ecf')}
            </SelectItem>
            <SelectItem value="client_secret_jwt">
              {tI18nComplete.raw('text7d06167236bd')}
            </SelectItem>
            <SelectItem value="private_key_jwt">{tI18nComplete.raw('text6ac8fd822515')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {value.authMethod === 'private_key_jwt' ? (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={id('private-key')}>
            {tI18nComplete.raw('text7251cfc3ceab')}
          </FieldLabel>
          <Textarea
            id={id('private-key')}
            value={value.privateKey}
            onChange={(event) => set('privateKey', event.target.value)}
            className="min-h-32 font-mono text-xs"
            required
          />
        </Field>
      ) : value.authMethod === 'none' ? null : (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={id('client-secret')}>
            {tI18nComplete.raw('text4aded5faf156')}
          </FieldLabel>
          <Input
            id={id('client-secret')}
            type="password"
            value={value.clientSecret}
            onChange={(event) => set('clientSecret', event.target.value)}
            variant="popover"
            required
          />
        </Field>
      )}
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={id('scopes')}>{tI18nComplete.raw('text0d5644ff52ce')}</FieldLabel>
        <Input
          id={id('scopes')}
          value={value.scopes}
          onChange={(event) => set('scopes', event.target.value)}
          placeholder={tI18nComplete.raw('text0b9de98b65ef')}
          variant="popover"
        />
        <FieldDescription>{tI18nComplete.raw('textda4365b5d2bf')}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={id('resource')}>{tI18nComplete.raw('texteb7a842ff958')}</FieldLabel>
        <Input
          id={id('resource')}
          value={value.resource}
          onChange={(event) => set('resource', event.target.value)}
          placeholder={tI18nComplete.raw('text59be71333c96')}
          variant="popover"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id('audience')}>{tI18nComplete.raw('text545c02357695')}</FieldLabel>
        <Input
          id={id('audience')}
          value={value.audience}
          onChange={(event) => set('audience', event.target.value)}
          placeholder={tI18nComplete.raw('text59be71333c96')}
          variant="popover"
        />
      </Field>
    </FieldGroup>
  );
}
