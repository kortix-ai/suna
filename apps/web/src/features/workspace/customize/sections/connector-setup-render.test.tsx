import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => ({ raw: (key: string) => key }),
}));
mock.module('@/i18n/use-localized-ui-catalog', () => ({
  useLocalizedUiCatalog: (value: unknown) => value,
}));
const host = (tag: string) =>
  function Collaborator({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
    return React.createElement(tag, props, children);
  };
mock.module('@/components/ui/modal', () =>
  Object.fromEntries(
    [
      'Modal',
      'ModalBody',
      'ModalContent',
      'ModalDescription',
      'ModalFooter',
      'ModalHeader',
      'ModalTitle',
    ].map((name) => [name, host('div')]),
  ),
);
mock.module('motion/react', () => ({ m: { div: host('div') } }));
mock.module('@/components/ui/toast', () => ({ successToast: () => {} }));
mock.module('./component/manifest-copy-block', () => ({ ManifestCopyBlock: host('pre') }));
const mutation = {
  isPending: false,
  mutate: (_value: unknown, options: { onSuccess: () => void }) => options.onSuccess(),
};
mock.module('@/hooks/channels/use-channels-installations', () => ({
  useConnectSlack: () => mutation,
  useSlackManifest: () => ({ data: '{}' }),
}));
mock.module('@/hooks/channels/use-teams-installations', () => ({
  useConnectTeams: () => mutation,
  useTeamsManifest: () => ({ data: '{}' }),
}));
mock.module('@/components/ui/select', () =>
  Object.fromEntries(
    ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'].map((name) => [
      name,
      host(name === 'SelectItem' ? 'option' : 'div'),
    ]),
  ),
);
const { SlackByoWizard } = await import('./component/slack-byo-wizard');
const { TeamsByoWizard } = await import('./component/teams-byo-wizard');
const { OAuth2CredentialFields } = await import('./connector-oauth2-fields');
const { OAuth2ApplicationFields } = await import('./connector-oauth2-application-fields');
const { EMPTY_OAUTH2_CREDENTIAL_FORM, EMPTY_OAUTH2_APPLICATION_FORM } =
  await import('./connector-oauth2');
async function render(element: React.ReactElement) {
  let renderer: ReactTestRenderer | undefined;
  await act(() => {
    renderer = create(element);
  });
  if (!renderer) throw new Error('Renderer was not created');
  return renderer;
}
async function click(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType('button')
    .find((node) => node.children.includes(label));
  expect(button).toBeDefined();
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(() => button.props.onClick());
}
for (const platform of ['slack', 'teams'])
  test(`${platform} actual wizard gates, mounted body, revisits and completion`, async () => {
    const closed: boolean[] = [];
    const props = {
      projectId: 'synthetic-project',
      open: true,
      onOpenChange: (value: boolean) => closed.push(value),
    };
    const renderer = await render(
      platform === 'slack' ? <SlackByoWizard {...props} /> : <TeamsByoWizard {...props} />,
    );
    const gates = () =>
      renderer.root
        .findAllByType('button')
        .filter((node) => node.props['data-slot'] === 'stepper-trigger');
    expect(gates().map((node) => node.props.disabled)).toEqual([false, true, true]);
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    await click(renderer, platform === 'slack' ? 'textbf16dc964c99' : 'text97fa07f21de8');
    expect(gates().map((node) => node.props.disabled)).toEqual([false, false, true]);
    await act(() => gates()[0].props.onClick());
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(gates().map((node) => node.props.disabled)).toEqual([false, true, true]);
    await click(renderer, platform === 'slack' ? 'textbf16dc964c99' : 'text97fa07f21de8');
    if (platform === 'slack') await click(renderer, 'texta695ac413d60');
    const inputs = renderer.root.findAllByType('input');
    expect(inputs.length).toBe(platform === 'slack' ? 2 : 3);
    const commit = platform === 'slack' ? 'textaa665ddf2727' : 'text5df0a8e1f30f';
    const commitButton = renderer.root
      .findAllByType('button')
      .find((node) => node.children.includes(commit));
    if (!commitButton) throw new Error(`Missing button: ${commit}`);
    expect(commitButton.props.disabled).toBe(true);
    for (const input of inputs)
      await act(() => input.props.onChange({ target: { value: ' synthetic-value ' } }));
    await click(renderer, commit);
    expect(closed).toEqual(platform === 'slack' ? [false] : []);
    if (platform === 'teams') {
      expect(renderer.root.findAllByType('input')).toHaveLength(0);
      expect(gates().map((node) => node.props.disabled)).toEqual([false, false, false]);
      await click(renderer, 'text11a6767d5674');
      expect(closed).toEqual([false]);
    }
    await act(() => renderer.unmount());
  });

for (const application of [false, true])
  test(`actual OAuth ${application ? 'application' : 'credential'} fields`, async () => {
    const value = application ? EMPTY_OAUTH2_APPLICATION_FORM : EMPTY_OAUTH2_CREDENTIAL_FORM;
    const changes: unknown[] = [];
    const renderer = await render(
      application ? (
        <OAuth2ApplicationFields
          value={EMPTY_OAUTH2_APPLICATION_FORM}
          onChange={(next) => changes.push(next)}
          idPrefix="test"
        />
      ) : (
        <OAuth2CredentialFields
          value={EMPTY_OAUTH2_CREDENTIAL_FORM}
          onChange={(next) => changes.push(next)}
          idPrefix="test"
        />
      ),
    );
    for (const key of ['scopes', 'resource', 'audience']) {
      const input = renderer.root
        .findAllByType('input')
        .find((node) => node.props.id === `test-${key}`);
      if (!input) throw new Error(`Missing input: test-${key}`);
      expect(input.props.value).toBe('');
      expect(input.props.placeholder).toBe(
        key === 'scopes'
          ? application
            ? 'text0b9de98b65ef'
            : 'textd39d2a43676f'
          : 'text59be71333c96',
      );
      expect(
        renderer.root.findAllByType('label').some((node) => node.props.htmlFor === input.props.id),
      ).toBe(true);
      await act(() => input.props.onChange({ target: { value: 'changed' } }));
      expect(changes.at(-1)).toEqual({ ...value, [key]: 'changed' });
    }
    expect(renderer.root.findAllByType('option').map((node) => node.props.value)).toEqual(
      application
        ? [
            'none',
            'client_secret_basic',
            'client_secret_post',
            'client_secret_jwt',
            'private_key_jwt',
          ]
        : [
            'none',
            'client_secret_post',
            'client_secret_basic',
            'client_secret_jwt',
            'private_key_jwt',
          ],
    );
    const tokenUrl = renderer.root
      .findAllByType('input')
      .find((node) => node.props.id === 'test-token-url');
    if (!tokenUrl) throw new Error('Missing input: test-token-url');
    expect(tokenUrl.props.required).toBe(application ? undefined : true);
    const clientSecret = renderer.root
      .findAllByType('input')
      .find((node) => node.props.id === 'test-client-secret');
    if (!clientSecret) throw new Error('Missing input: test-client-secret');
    expect(clientSecret.props.required).toBe(true);
    await act(() => renderer.unmount());
  });

for (const authMethod of [
  'none',
  'client_secret_post',
  'client_secret_basic',
  'client_secret_jwt',
  'private_key_jwt',
] as const) {
  test(`actual OAuth requirements for ${authMethod}`, async () => {
    for (const application of [false, true]) {
      const renderer = await render(
        application ? (
          <OAuth2ApplicationFields
            value={{ ...EMPTY_OAUTH2_APPLICATION_FORM, authMethod, grant: 'device_authorization' }}
            onChange={() => {}}
            idPrefix="auth"
          />
        ) : (
          <OAuth2CredentialFields
            value={{ ...EMPTY_OAUTH2_CREDENTIAL_FORM, authMethod }}
            onChange={() => {}}
            idPrefix="auth"
          />
        ),
      );
      const inputs = renderer.root.findAllByType('input');
      expect(inputs.some((node) => node.props.id === 'auth-client-secret')).toBe(
        authMethod !== 'none' && authMethod !== 'private_key_jwt',
      );
      expect(renderer.root.findAllByType('textarea').length).toBe(
        authMethod === 'private_key_jwt' ? 1 : 0,
      );
      if (authMethod === 'private_key_jwt') {
        expect(renderer.root.findByType('textarea').props.required).toBe(true);
        expect(inputs.some((node) => node.props.id === 'auth-thumbprint')).toBe(!application);
      }
      expect(inputs.some((node) => node.props.id === 'auth-device-url')).toBe(application);
      expect(inputs.some((node) => node.props.id === 'auth-authorization-url')).toBe(false);
      await act(() => renderer.unmount());
    }
  });
}
