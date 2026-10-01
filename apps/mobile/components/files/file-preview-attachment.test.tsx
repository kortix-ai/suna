import { afterAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { configureKortix } from '../../../../packages/sdk/src/core/http/config';

const calls: Array<{ previewType: string; blobUrl?: string }> = [];
const saves: string[] = [];
const downloads: string[] = [];
const ref = 'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';
configureKortix({ backendUrl: 'https://example.test', getToken: async () => 'test-token' });
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  expect(String(url)).toBe('https://example.test/projects/11111111-1111-4111-8111-111111111111/sessions/22222222-2222-4222-8222-222222222222/attachments/33333333-3333-4333-8333-333333333333');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
  return new Response('image', { headers: { 'content-type': 'image/png' } });
}) as typeof fetch;

mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
mock.module('react-native', () => ({ View: ({ children }: { children?: React.ReactNode }) => children }));
mock.module('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', downloadAsync: async (url: string, uri: string) => { downloads.push(url); return { status: 200, uri }; }, deleteAsync: async () => {} }));
mock.module('@/api/config', () => ({ API_URL: 'https://example.test', getAuthToken: async () => 'test-token' }));
mock.module('@tanstack/react-query', () => ({ useQuery: ({ queryFn, enabled }: { queryFn: () => Promise<Blob>; enabled: boolean }) => {
  const [data, setData] = React.useState<Blob>();
  React.useEffect(() => { if (enabled) void queryFn().then(setData); }, [enabled]);
  return { data, isLoading: enabled && !data, refetch: queryFn };
} }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/files/FilePreviewRenderers', () => ({ FilePreview: (props: { previewType: string; blobUrl?: string }) => { calls.push(props); return null; }, FilePreviewBottomInsetContext: React.createContext(0), getFilePreviewType: (name: string) => name.endsWith('.png') ? 'image' : name.endsWith('.pdf') ? 'pdf' : name.endsWith('.docx') ? 'docx' : name.endsWith('.xlsx') ? 'xlsx' : 'text' }));
mock.module('@/components/files/use-file-preview-data', () => ({ useFilePreviewData: () => ({ previewType: 'other' }) }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: () => null }));
mock.module('@/components/kortix/pinned-bar', () => ({ PinnedBar: ({ children }: { children?: React.ReactNode }) => children, usePinnedBarInset: () => 0 }));
mock.module('@/components/kortix/sheet', () => ({ CopyContentButton: () => null, KortixBottomSheetModal: () => null }));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
mock.module('@/components/session/tool/shared/tool-icons', () => ({ showFileTypeIcon: () => null }));
mock.module('@/components/ui/button', () => ({ Button: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('button', props, children) }));
mock.module('@/components/ui/icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/text', () => ({ Text: () => null }));
mock.module('@/lib/session/session-files', () => ({ previewsInline: (name: string) => !['pdf', 'docx', 'xlsx'].includes(name.split('.').at(-1) ?? ''), sessionFileKindLabel: () => 'File' }));
mock.module('@/lib/files/preview-failure', () => ({ previewFailure: () => null }));
mock.module('@/lib/files/hooks', () => ({ blobToDataURL: async () => 'data:image/png;base64,aW1hZ2U=', downloadOpenCodeFileToCache: async () => '' }));
mock.module('@/lib/files/save-to-device', () => ({ saveFileToDevice: async (uri: string) => { saves.push(uri); return { status: 'saved', folder: 'Downloads' }; } }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: () => {}, success: () => {}, warning: () => {} } }));
mock.module('@/lib/icons', () => ({ DownloadSimpleIcon: () => null, PlusIcon: () => null }));
mock.module('@/lib/utils/theme', () => ({ THEME: { light: { background: '#fff' } } }));

// Render the actual body: the query and native leaves are stubbed, not the routing decision.
describe('stored attachment preview', () => {
  test.each(['pdf', 'docx', 'xlsx'])('shows a download-only card for %s attachment', async (extension) => {
    const { FilePreviewBody } = await import('./FilePreviewSheet');
    let tree: ReactTestRenderer | undefined;
    const rendered = calls.length;
    await act(async () => { tree = create(<FilePreviewBody file={{ name: `document.${extension}`, path: ref }} sandboxUrl={undefined} onCopyTextChange={() => {}} />); });
    expect(calls).toHaveLength(rendered);
    expect(tree?.root.findByProps({ accessibilityLabel: 'Download file' })).toBeDefined();
    await act(async () => { tree?.unmount(); });
  });

  test('renders an image and downloads its authenticated bytes', async () => {
    const { FilePreviewBody } = await import('./FilePreviewSheet');
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(<FilePreviewBody file={{ name: 'photo.png', path: ref }} sandboxUrl={undefined} onCopyTextChange={() => {}} />); });
    expect(calls.at(-1)).toMatchObject({ previewType: 'image', blobUrl: 'data:image/png;base64,aW1hZ2U=' });
    const button = tree!.root.findByProps({ accessibilityLabel: 'Download file' });
    await act(async () => { await button.props.onPress(); });
    expect(downloads).toEqual(['https://example.test/projects/11111111-1111-4111-8111-111111111111/sessions/22222222-2222-4222-8222-222222222222/attachments/33333333-3333-4333-8333-333333333333']);
    expect(saves).toEqual(['file:///cache/photo.png']);
    await act(async () => { tree?.unmount(); });
  });
});
