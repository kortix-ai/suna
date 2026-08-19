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
import type { OAuth2CredentialForm } from './connector-oauth2';

export function OAuth2CredentialFields({
  value,
  onChange,
  idPrefix,
  autoFocus = false,
}: {
  value: OAuth2CredentialForm;
  onChange: (value: OAuth2CredentialForm) => void;
  idPrefix: string;
  autoFocus?: boolean;
}) {
  const set = <K extends keyof OAuth2CredentialForm>(key: K, next: OAuth2CredentialForm[K]) =>
    onChange({ ...value, [key]: next });
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <FieldGroup className="grid gap-3 sm:grid-cols-2">
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={id('token-url')}>Token URL</FieldLabel>
        <Input
          id={id('token-url')}
          type="url"
          value={value.tokenUrl}
          onChange={(event) => set('tokenUrl', event.target.value)}
          placeholder="https://identity.example.com/oauth2/token"
          variant="popover"
          autoFocus={autoFocus}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id('client-id')}>Client ID</FieldLabel>
        <Input
          id={id('client-id')}
          value={value.clientId}
          onChange={(event) => set('clientId', event.target.value)}
          variant="popover"
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id('auth-method')}>Token authentication</FieldLabel>
        <Select
          value={value.authMethod}
          onValueChange={(next) => set('authMethod', next as OAuth2CredentialForm['authMethod'])}
        >
          <SelectTrigger id={id('auth-method')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Public client</SelectItem>
            <SelectItem value="client_secret_post">Client secret in body</SelectItem>
            <SelectItem value="client_secret_basic">Client secret with Basic</SelectItem>
            <SelectItem value="client_secret_jwt">Client secret JWT</SelectItem>
            <SelectItem value="private_key_jwt">Private key JWT</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {value.authMethod === 'private_key_jwt' ? (
        <>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={id('private-key')}>Private key PEM</FieldLabel>
            <Textarea
              id={id('private-key')}
              value={value.privateKey}
              onChange={(event) => set('privateKey', event.target.value)}
              className="min-h-32 font-mono text-xs"
              required
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={id('thumbprint')}>Certificate SHA-256 thumbprint</FieldLabel>
            <Input
              id={id('thumbprint')}
              type="password"
              value={value.certificateThumbprint}
              onChange={(event) => set('certificateThumbprint', event.target.value)}
              placeholder="Base64url x5t#S256 value"
              variant="popover"
            />
            <FieldDescription>Optional x5t#S256 JWT header value.</FieldDescription>
          </Field>
        </>
      ) : value.authMethod === 'none' ? (
        <Field className="sm:col-span-2">
          <FieldDescription>
            This public client does not authenticate at the token endpoint.
          </FieldDescription>
        </Field>
      ) : (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={id('client-secret')}>Client secret</FieldLabel>
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
        <FieldLabel htmlFor={id('scopes')}>Scopes</FieldLabel>
        <Input
          id={id('scopes')}
          value={value.scopes}
          onChange={(event) => set('scopes', event.target.value)}
          placeholder="api.read api.write"
          variant="popover"
        />
        <FieldDescription>Separate multiple scopes with spaces.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={id('resource')}>Resource</FieldLabel>
        <Input
          id={id('resource')}
          value={value.resource}
          onChange={(event) => set('resource', event.target.value)}
          placeholder="Optional"
          variant="popover"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id('audience')}>Audience</FieldLabel>
        <Input
          id={id('audience')}
          value={value.audience}
          onChange={(event) => set('audience', event.target.value)}
          placeholder="Optional"
          variant="popover"
        />
      </Field>
    </FieldGroup>
  );
}
