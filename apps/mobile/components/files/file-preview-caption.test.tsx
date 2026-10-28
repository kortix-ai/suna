/**
 * The file sheet's caption section: a generated image's prompt and the model
 * that made it, shown only when the file was opened with them. Every other
 * file opens as before.
 */
import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
mock.module('react-native', () => ({ View: ({ children, ...props }: HostProps) => React.createElement('view', props, children) }));
mock.module('@/components/ui/text', () => ({
  Text: ({ children }: HostProps) => React.createElement('text', null, children),
}));

const { FilePreviewCaption } = await import('./file-preview-caption');
const { useToolFilePreviewStore } = await import('@/stores/tool-file-preview-store');

function mount(element: React.ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(element);
  });
  return tree!;
}

function texts(element: React.ReactElement): string[] {
  const tree = mount(element);
  return tree.root.findAll((node) => node.type === 'text').map((node) => ([] as unknown[]).concat(node.props.children).join(''));
}

describe('the full-screen view shows the caption section only when caption data is given', () => {
  test('no caption, no section', () => {
    expect(mount(<FilePreviewCaption caption={undefined} />).toJSON()).toBeNull();
  });

  test('a caption shows the prompt and the model', () => {
    expect(texts(<FilePreviewCaption caption={{ text: 'A fox in a shuttle', model: 'codex/gpt-image-2' }} />)).toEqual([
      'A fox in a shuttle',
      'codex/gpt-image-2',
    ]);
    expect(texts(<FilePreviewCaption caption={{ text: 'A fox in a shuttle' }} />)).toEqual(['A fox in a shuttle']);
  });

  test('the preview store carries the caption of the file it opens, and only that open', () => {
    const store = useToolFilePreviewStore.getState();
    store.openPreview('/workspace/output/images/fox.png', undefined, { text: 'A fox in a shuttle', model: 'codex/gpt-image-2' });
    expect(useToolFilePreviewStore.getState().caption).toEqual({ text: 'A fox in a shuttle', model: 'codex/gpt-image-2' });
    useToolFilePreviewStore.getState().openPreview('/workspace/notes.md');
    expect(useToolFilePreviewStore.getState().caption).toBeNull();
    useToolFilePreviewStore.getState().closePreview();
  });
});
