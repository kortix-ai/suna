import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const calls: Array<{ previewType: string; blobUrl?: string }> = [];
const saves: string[] = [];
const fetches: string[] = [];
const ref = 'kortix-attachment://session-1/image-1';
const blob = new Blob(['image'], { type: 'image/png' });

mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
mock.module('react-native', () => ({ View: ({ children }: { children?: React.ReactNode }) => children }));
mock.module('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, writeAsStringAsync: async (uri: string) => { saves.push(uri); } }));
mock.module('@kortix/sdk', () => ({ isSessionAttachmentRef: (path: string) => path.startsWith('kortix-attachment://'), fetchSessionAttachment: async (path: string) => { fetches.push(path); return blob; } }));
mock.module('@tanstack/react-query', () => ({ useQuery: () => ({ data: blob, isLoading: false, refetch: async () => {} }) }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/files/FilePreviewRenderers', () => ({ FilePreview: (props: { previewType: string; blobUrl?: string }) => { calls.push(props); return null; }, FilePreviewBottomInsetContext: React.createContext(0), getFilePreviewType: (name: string) => name.endsWith('.png') ? 'image' : 'text' }));
mock.module('@/components/files/use-file-preview-data', () => ({ useFilePreviewData: () => ({ previewType: 'other' }) }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: () => null }));
mock.module('@/components/kortix/pinned-bar', () => ({ PinnedBar: ({ children }: { children?: React.ReactNode }) => children, usePinnedBarInset: () => 0 }));
mock.module('@/components/kortix/sheet', () => ({ CopyContentButton: () => null, KortixBottomSheetModal: () => null }));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
mock.module('@/components/session/tool/shared/tool-icons', () => ({ showFileTypeIcon: () => null }));
mock.module('@/components/ui/button', () => ({ Button: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('button', props, children) }));
mock.module('@/components/ui/icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/text', () => ({ Text: () => null }));
mock.module('@/lib/session/session-files', () => ({ previewsInline: () => true, sessionFileKindLabel: () => 'Image' }));
mock.module('@/lib/files/preview-limits', () => ({ previewDecision: () => 'ok' }));
mock.module('@/lib/files/preview-failure', () => ({ previewFailure: () => null }));
mock.module('@/lib/files/hooks', () => ({ blobToDataURL: async () => 'data:image/png;base64,aW1hZ2U=', downloadOpenCodeFileToCache: async () => '' }));
mock.module('@/lib/files/save-to-device', () => ({ saveFileToDevice: async (uri: string) => { saves.push(uri); return { status: 'saved', folder: 'Downloads' }; } }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: () => {}, success: () => {}, warning: () => {} } }));
mock.module('@/lib/icons', () => ({ DownloadSimpleIcon: () => null, PlusIcon: () => null }));
mock.module('@/lib/utils/theme', () => ({ THEME: { light: { background: '#fff' } } }));

// Render the actual body: the query and native leaves are stubbed, not the routing decision.
describe('stored attachment preview', () => {
  test('renders an image and downloads its authenticated bytes', async () => {
    const { FilePreviewBody } = await import('./FilePreviewSheet');
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(<FilePreviewBody file={{ name: 'photo.png', path: ref }} sandboxUrl={undefined} onCopyTextChange={() => {}} />); });
    expect(calls.at(-1)).toMatchObject({ previewType: 'image', blobUrl: 'data:image/png;base64,aW1hZ2U=' });
    const button = tree!.root.findByProps({ accessibilityLabel: 'Download file' });
    await act(async () => { await button.props.onPress(); });
    expect(fetches).toEqual([ref]);
    expect(saves).toEqual(['file:///cache/photo.png', 'file:///cache/photo.png']);
    await act(async () => { tree?.unmount(); });
  });
});
