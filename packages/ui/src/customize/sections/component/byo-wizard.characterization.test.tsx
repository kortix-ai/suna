import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

mock.module('../../../i18n', () => ({
  useTranslations: () => ({ raw: (key: string) => key }),
}));
mock.module('../../../i18n/ui-catalog/use-localized-ui-catalog', () => ({
  useLocalizedUiCatalog: (value: unknown) => value,
}));
const host = (tag: string) =>
  function Collaborator({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
    return React.createElement(tag, props, children);
  };
const uiModalMock = () =>
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
  );
mock.module('../../../primitives/modal', uiModalMock);
mock.module('@kortix/ui/modal', uiModalMock);
const motion = await import('motion/react');
mock.module('motion/react', () => ({ ...motion, m: { ...motion.m, div: host('div') } }));
const uiToastMock = () => ({ successToast: () => {} });
mock.module('../../../primitives/toast', uiToastMock);
mock.module('@kortix/ui/toast', uiToastMock);
mock.module('./manifest-copy-block', () => ({ ManifestCopyBlock: host('pre') }));
mock.module('../../../markdown/copy-button', () => ({ CopyButton: host('span') }));
const submissions: unknown[] = [];
const mutation = {
  isPending: false,
  mutate: (value: unknown, options: { onSuccess: () => void }) => {
    submissions.push(value);
    options.onSuccess();
  },
};
mock.module('../../../internal/hooks/channels/use-channels-installations', () => ({
  useConnectSlack: () => mutation,
  useSlackManifest: () => ({ data: '{}' }),
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useConnectTeams: () => mutation,
  useTeamsManifest: () => ({ data: '{}' }),
}));
const uiSelectMock = () =>
  Object.fromEntries(
    ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'].map((name) => [
      name,
      host(name === 'SelectItem' ? 'option' : 'div'),
    ]),
  );
mock.module('../../../primitives/select', uiSelectMock);
mock.module('@kortix/ui/select', uiSelectMock);
const { SlackByoWizard } = await import('./slack-byo-wizard');
const { TeamsByoWizard } = await import('./teams-byo-wizard');
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
      platform === 'slack' ? <SlackByoWizard {...props} /> : <TeamsByoWizard {...props} mode={undefined} />,
    );
    const gates = () =>
      renderer.root
        .findAllByType('button')
        .filter((node) => node.props['data-slot'] === 'stepper-trigger');
    expect(gates().map((node) => node.props.disabled)).toEqual([false, true, true]);
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(renderer.root.findByType('aside').props.className).toBe(platform === 'slack'
      ? 'flex flex-col gap-6 border-b bg-sidebar p-5 lg:w-72 lg:shrink-0 lg:border-e lg:border-b-0'
      : 'bg-sidebar flex flex-col gap-6 border-b p-6 lg:w-72 lg:shrink-0 lg:border-e lg:border-b-0');
    expect(renderer.root.findByType('footer').props.className).toBe(platform === 'slack'
      ? 'flex items-center justify-between gap-3 border-t px-6 py-4'
      : 'flex items-center justify-between gap-4 border-t px-6 py-4');
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
    expect(submissions.at(-1)).toEqual(platform === 'slack'
      ? { projectId: 'synthetic-project', bot_token: 'synthetic-value', signing_secret: 'synthetic-value' }
      : { projectId: 'synthetic-project', tenant_id: 'synthetic-value', app_id: 'synthetic-value', app_password: 'synthetic-value' });
    expect(closed).toEqual(platform === 'slack' ? [false] : []);
    if (platform === 'teams') {
      expect(renderer.root.findAllByType('input')).toHaveLength(0);
      expect(gates().map((node) => node.props.disabled)).toEqual([false, false, false]);
      await click(renderer, 'text11a6767d5674');
      expect(closed).toEqual([false]);
    }
    await act(() => renderer.unmount());
  });
