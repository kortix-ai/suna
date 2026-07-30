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
  const set = <K extends keyof OAuth2ApplicationForm>(key: K, next: OAuth2ApplicationForm[K]) =>
    onChange({ ...value, [key]: next });
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <FieldGroup className="grid gap-3 sm:grid-cols-2">
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={id('discovery-url')}>Discovery URL</FieldLabel>
        <Input
          id={id('discovery-url')}
          type="url"
          value={value.discoveryUrl}
          onChange={(event) => set('discoveryUrl', event.target.value)}
          placeholder="https://identity.example.com/.well-known/openid-configuration"
          variant="popover"
        />
        <FieldDescription>
          RFC 8414 or OpenID metadata can supply the endpoint URLs below.
        </FieldDescription>
      </Field>
      {value.grant === 'authorization_code' && (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={id('authorization-url')}>Authorization URL</FieldLabel>
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
        <FieldLabel htmlFor={id('token-url')}>Token URL</FieldLabel>
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
          <FieldLabel htmlFor={id('device-url')}>Device Authorization URL</FieldLabel>
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
        <FieldLabel htmlFor={id('revocation-url')}>Revocation URL</FieldLabel>
        <Input
          id={id('revocation-url')}
          type="url"
          value={value.revocationUrl}
          onChange={(event) => set('revocationUrl', event.target.value)}
          placeholder="https://identity.example.com/oauth2/revoke"
          variant="popover"
        />
        <FieldDescription>
          Optional. Kortix also deletes the local token on disconnect.
        </FieldDescription>
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
          onValueChange={(next) => set('authMethod', next as OAuth2ApplicationForm['authMethod'])}
        >
          <SelectTrigger id={id('auth-method')} variant="popover">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Public client</SelectItem>
            <SelectItem value="client_secret_basic">Client secret with Basic</SelectItem>
            <SelectItem value="client_secret_post">Client secret in body</SelectItem>
            <SelectItem value="client_secret_jwt">Client secret JWT</SelectItem>
            <SelectItem value="private_key_jwt">Private key JWT</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {value.authMethod === 'private_key_jwt' ? (
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
      ) : value.authMethod === 'none' ? null : (
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
          placeholder="openid profile api.read"
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
