import { afterEach, expect, mock, test } from 'bun:test';
import type { QuestionRequest } from '@/lib/session/types';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

const host = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props);
mock.module('react-native', () => ({
  View: host('View'),
  ScrollView: host('ScrollView'),
  TextInput: host('TextInput'),
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/ui/text', () => ({ Text: host('Text') }));
mock.module('@/components/ui/button', () => ({ Button: host('Button') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('Icon') }));
mock.module('@/components/kortix/pressable-surface', () => ({ PressableSurface: host('Option') }));
mock.module('@/components/kortix/composer', () => ({ COMPOSER_CONTROL_HIT_SLOP: 4 }));
mock.module('@/components/kortix/pill-input', () => ({
  INPUT_FONT_FAMILY: 'Roobert',
  INPUT_FONT_SIZE: 16,
}));
mock.module('@/lib/icons', () => ({ ArrowUpIcon: host('Arrow'), CheckIcon: host('Check') }));
mock.module('expo-router/react-navigation', () => ({
  DefaultTheme: { colors: {} },
  DarkTheme: { colors: {} },
}));
const { QuestionPrompt } = await import('./QuestionPrompt');
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
});
const request: QuestionRequest = {
  id: 'q',
  sessionID: 's',
  questions: [
    {
      header: 'Choose',
      question: 'Which?',
      multiple: true,
      options: [
        { label: 'A', description: 'First' },
        { label: 'B', description: 'Second' },
      ],
    },
  ],
};
function deferred() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function mount(
  onReply: React.ComponentProps<typeof QuestionPrompt>['onReply'],
  onReject: React.ComponentProps<typeof QuestionPrompt>['onReject'],
  value = request,
) {
  await act(async () => {
    renderer = create(<QuestionPrompt request={value} onReply={onReply} onReject={onReject} />);
  });
}
function send() {
  return renderer.root.findByProps({ accessibilityLabel: 'Send answer' });
}
async function draftAndPick() {
  await act(async () =>
    renderer.root.findAll((node) => String(node.type) === 'Option')[0].props.onPress(),
  );
  await act(async () =>
    renderer.root.find((node) => String(node.type) === 'TextInput').props.onChangeText('draft'),
  );
}
function assertPreserved() {
  expect(renderer.root.find((node) => String(node.type) === 'TextInput').props.value).toBe('draft');
  expect(
    renderer.root.findAll((node) => String(node.type) === 'Option')[0].props.accessibilityState
      .checked,
  ).toBe(true);
}
for (const action of ['reply', 'reject']) {
  test(`failed ${action} preserves answers and enables retry`, async () => {
    const pending = deferred();
    const retry = deferred();
    const callback = mock(() =>
      callback.mock.calls.length === 1 ? pending.promise : retry.promise,
    );
    await mount(
      action === 'reply' ? callback : () => {},
      action === 'reject' ? callback : () => {},
    );
    await draftAndPick();
    const press =
      action === 'reply'
        ? send().props.onPress
        : renderer.root.findAll((node) => String(node.type) === 'Button')[0].props.onPress;
    await act(async () => {
      void press();
      void press();
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(renderer.toJSON()).not.toBeNull();
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Button')
        .every((button) => button.props.disabled),
    ).toBe(true);
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Option')
        .every((option) => option.props.disabled),
    ).toBe(true);
    expect(renderer.root.find((node) => String(node.type) === 'TextInput').props.editable).toBe(
      false,
    );
    await act(async () => {
      pending.reject(new Error('offline'));
    });
    assertPreserved();
    expect(send().props.disabled).toBe(false);
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some(
          (text) =>
            text.props.variant === 'muted' && String(text.props.children).includes('try again'),
        ),
    ).toBe(true);
    expect(renderer.root.find((node) => String(node.type) === 'TextInput').props.editable).toBe(
      true,
    );
    await act(async () =>
      renderer.root
        .find((node) => String(node.type) === 'TextInput')
        .props.onChangeText('edited draft'),
    );
    expect(renderer.root.find((node) => String(node.type) === 'TextInput').props.value).toBe(
      'edited draft',
    );
    await act(async () => {
      void (
        action === 'reply'
          ? send().props.onPress
          : renderer.root.findAll((node) => String(node.type) === 'Button')[0].props.onPress
      )();
    });
    expect(callback).toHaveBeenCalledTimes(2);
    if (action === 'reply') expect(callback).toHaveBeenLastCalledWith('q', [['A', 'edited draft']]);
    else expect(callback).toHaveBeenLastCalledWith('q');
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some((text) => String(text.props.children).includes('try again')),
    ).toBe(false);
    await act(async () => retry.resolve());
    expect(renderer.toJSON()).not.toBeNull();
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Button')
        .every((button) => button.props.disabled),
    ).toBe(true);
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Option')
        .every((option) => option.props.disabled),
    ).toBe(true);
    expect(renderer.root.find((node) => String(node.type) === 'TextInput').props.editable).toBe(
      false,
    );
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some((text) => String(text.props.children).includes('try again')),
    ).toBe(false);
    await act(async () => {
      void send().props.onPress();
      void renderer.root.findAll((node) => String(node.type) === 'Button')[0].props.onPress();
    });
    expect(callback).toHaveBeenCalledTimes(2);
    await act(async () => renderer.update(null));
    expect(renderer.toJSON()).toBeNull();
  });
}
test('multi-step reply waits for removal and never repeats a successful action', async () => {
  const pending = deferred();
  const reply = mock(() => pending.promise);
  await mount(reply, () => {}, {
    ...request,
    questions: [{ ...request.questions[0], multiple: false }, request.questions[0]],
  });
  await act(async () =>
    renderer.root.findAll((node) => String(node.type) === 'Option')[0].props.onPress(),
  );
  await draftAndPick();
  await act(async () => {
    void send().props.onPress();
  });
  expect(reply).toHaveBeenCalledWith('q', [['A'], ['A', 'draft']]);
  expect(
    renderer.root
      .findAll((node) => String(node.type) === 'Button')
      .every((button) => button.props.disabled),
  ).toBe(true);
  await act(async () => pending.resolve());
  expect(renderer.toJSON()).not.toBeNull();
  await act(async () => {
    void send().props.onPress();
    void renderer.root.findAll((node) => String(node.type) === 'Button')[0].props.onPress();
  });
  expect(reply).toHaveBeenCalledTimes(1);
});

test('failed final single-choice reply preserves the picked answer and draft', async () => {
  const pending = deferred();
  const reply = mock(() => pending.promise);
  await mount(reply, () => {}, {
    ...request,
    questions: [{ ...request.questions[0], multiple: false }],
  });
  await act(async () =>
    renderer.root.find((node) => String(node.type) === 'TextInput').props.onChangeText('draft'),
  );
  await act(async () => {
    void renderer.root.findAll((node) => String(node.type) === 'Option')[0].props.onPress();
  });
  expect(reply).toHaveBeenCalledWith('q', [['A']]);
  await act(async () => pending.reject(new Error('offline')));
  expect(renderer.root.find((node) => String(node.type) === 'TextInput').props.value).toBe('draft');
  await act(async () =>
    renderer.root.find((node) => String(node.type) === 'TextInput').props.onChangeText(''),
  );
  expect(send().props.disabled).toBe(false);
});
