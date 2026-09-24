/**
 * FilePreviewSheet — the one file preview of the app (Jay, 2026-09-22).
 *
 * The sheet Recent files opens, now shared: the file name as the title, a
 * close button at the far left, Copy at the far right (text files), the
 * document as the body, and the project drawer's pinned bar at the bottom —
 * Download, plus "Add to chat" when the caller can take the file.
 *
 * Every file open goes through this, so a file looks the same wherever it is
 * tapped: a Recent files row, a `show` tool's Preview, a read row, a generated
 * image. **`FileViewer` (the full-screen modal) is not used for any of those
 * any more.**
 *
 * The body renders markdown, HTML, CSV, JSON, code, text and images. A file it
 * does not render — a PDF, an Office file, an archive, media
 * (`previewsInline`) — shows its file card and fetches nothing; Download hands
 * it to the device instead.
 */
import * as React from 'react';
import { View } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SandboxFile } from '@/api/types';
import { FilePreview, FilePreviewBottomInsetContext } from '@/components/files/FilePreviewRenderers';
import { useFilePreviewData } from '@/components/files/use-file-preview-data';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { CopyContentButton, KortixBottomSheetModal, type SheetRef } from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { showFileTypeIcon } from '@/components/session/tool/shared/show-helpers';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { downloadOpenCodeFileToCache } from '@/lib/files/hooks';
import { openFileOnDevice } from '@/lib/files/open-on-device';
import { previewFailure } from '@/lib/files/preview-failure';
import { haptics } from '@/lib/haptics';
import { DownloadSimpleIcon, PlusIcon } from '@/lib/icons';
import { previewsInline, sessionFileKindLabel, type SessionFileKind } from '@/lib/session/session-files';
import { THEME } from '@/lib/utils/theme';

/** What the sheet needs of a file. A tool path knows only its name and path. */
export interface PreviewFile {
  name: string;
  path: string;
  /** Set by Recent files; a tool path leaves it out and the card names the type from the extension. */
  kind?: SessionFileKind;
}

const SNAP_POINTS = ['100%'];
/** `Button` default height: the pinned bar's row. */
const BAR_CONTROL_HEIGHT = 40;

/** Sandbox paths are absolute; a relative one is workspace-relative. */
function toSandboxFile(file: PreviewFile): SandboxFile {
  const path = file.path.startsWith('/') ? file.path : `/workspace/${file.path}`;
  return { name: file.name, path, type: 'file' } as SandboxFile;
}

export interface FilePreviewSheetProps {
  /** The file to show, or null while the sheet is closed. */
  file: PreviewFile | null;
  /** The session's sandbox: where the file loads from. */
  sandboxUrl: string | undefined;
  /** "Add to chat". Omit where there is no composer to add it to, and the bar keeps Download alone. */
  onAdd?: (file: PreviewFile) => void;
  /** The sheet closed: clear the caller's file. */
  onDismiss?: () => void;
  /** Pushed over another sheet (Recent files), rather than opened on its own. */
  pushed?: boolean;
}

/**
 * Only the handle and the title row drag the sheet, so a long document scrolls
 * inside it. The surface is the page colour, the same plane the file renderers
 * paint, so title row, preview, fades and actions read as one sheet.
 */
export const FilePreviewSheet = React.forwardRef<SheetRef, FilePreviewSheetProps>(
  ({ file, sandboxUrl, onAdd, onDismiss, pushed = false }, ref) => {
    const modalRef = React.useRef<BottomSheetModal>(null);
    const insets = useSafeAreaInsets();
    const { colorScheme } = useColorScheme();
    const pageBackground = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;
    // The previewed file's text, once it has loaded: what the title row's Copy copies.
    const [copyText, setCopyText] = React.useState('');

    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));

    return (
      <KortixBottomSheetModal
        ref={modalRef}
        title={file?.name}
        titleTrailing={copyText ? <CopyContentButton text={copyText} /> : undefined}
        {...(pushed ? { stackBehavior: 'push' as const } : null)}
        snapPoints={SNAP_POINTS}
        enableDynamicSizing={false}
        topInset={insets.top}
        enablePanDownToClose
        enableContentPanningGesture={false}
        backgroundStyle={{ backgroundColor: pageBackground }}
        onDismiss={() => {
          setCopyText('');
          onDismiss?.();
        }}>
        {file ? (
          <FilePreviewBody
            file={file}
            sandboxUrl={sandboxUrl}
            onCopyTextChange={setCopyText}
            onAdd={
              onAdd
                ? () => {
                    haptics.selection();
                    modalRef.current?.dismiss();
                    onAdd(file);
                  }
                : undefined
            }
          />
        ) : null}
      </KortixBottomSheetModal>
    );
  },
);
FilePreviewSheet.displayName = 'FilePreviewSheet';

export function FilePreviewBody({
  file,
  sandboxUrl,
  onCopyTextChange,
  onAdd,
}: {
  file: PreviewFile;
  sandboxUrl: string | undefined;
  /** The file's text once it has loaded, else ''. */
  onCopyTextChange: (text: string) => void;
  /** Omit to leave Download alone in the bar. */
  onAdd?: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const pageBackground = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;
  const contentInset = usePinnedBarInset(BAR_CONTROL_HEIGHT);
  const toast = useToast();
  const sandboxFile = React.useMemo(() => toSandboxFile(file), [file]);
  // A PDF, an Office file, an archive or media is not rendered here and nothing
  // is fetched for it (Jay, 2026-09-22): the body is its file card.
  // An SVG is never drawn (Jay, 2026-09-22, `lib/files/svg-policy`): it reads
  // as its markup, so the title row's Copy has something to put on the
  // clipboard and Download hands the real file to the device.
  const inline = previewsInline(file.name);
  const preview = useFilePreviewData(sandboxFile, sandboxUrl, { enabled: inline });

  const failed = inline && (Boolean(preview.error) || !sandboxUrl);
  const failure = failed ? previewFailure(preview.error, Boolean(sandboxUrl)) : null;

  const copyText =
    inline && !failed && typeof preview.textContent === 'string' ? preview.textContent : '';
  React.useEffect(() => {
    onCopyTextChange(copyText);
  }, [copyText, onCopyTextChange]);

  const [downloading, setDownloading] = React.useState(false);
  const handleDownload = async () => {
    if (!sandboxUrl || downloading) return;
    haptics.tap();
    setDownloading(true);
    let uri: string;
    try {
      // Streams to disk natively, so it works for a file of any size or type.
      uri = await downloadOpenCodeFileToCache(sandboxUrl, sandboxFile.path, sandboxFile.name);
    } catch {
      haptics.warning();
      toast.error('Unable to download the file. Try again.');
      setDownloading(false);
      return;
    }
    try {
      // The device opens it in its own app: the PDF, slides, sheet or text app
      // on Android, Quick Look on iOS. Never the share sheet, never an in-app
      // viewer (Jay, 2026-09-22).
      const result = await openFileOnDevice(uri, sandboxFile.name);
      if (result === 'no-app') toast.info('File downloaded. No app on this device can open it.');
      else if (result === 'unavailable') toast.info('File downloaded. Update the app to open it.');
    } catch {
      haptics.warning();
      toast.error('File downloaded, but it did not open. Try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    // A plain `View`: `BottomSheetView` sizes to its content, and this sheet has a
    // fixed height, so the preview fills it and the bar pins to its bottom edge.
    <View className="flex-1">
      {/* The document fills the sheet and scrolls under the pinned bar; the
          renderers end their content `contentInset` above the edge. */}
      <FilePreviewBottomInsetContext.Provider value={contentInset}>
        {!inline ? (
          <View
            className="flex-1 items-center justify-center gap-3 px-8"
            style={{ paddingBottom: contentInset }}>
            <Icon
              as={showFileTypeIcon(file.kind ?? '', file.name)}
              size={40}
              className="text-muted-foreground"
            />
            <Text variant="large" className="text-center" numberOfLines={2}>
              {file.name}
            </Text>
            <Text variant="muted">{sessionFileKindLabel({ name: file.name, kind: file.kind ?? 'file' })}</Text>
          </View>
        ) : preview.isLoading ? (
          <View
            className="flex-1 items-center justify-center"
            style={{ paddingBottom: contentInset }}>
            <KortixLoader size="large" />
          </View>
        ) : failure ? (
          <View
            className="flex-1 items-center justify-center gap-6 px-8"
            style={{ paddingBottom: contentInset }}>
            <Text variant="muted" className="text-center">
              {failure.message}
            </Text>
            {failure.canRetry && sandboxUrl ? (
              <Button
                variant="secondary"
                size="lg"
                className="rounded-full"
                onPress={() => {
                  haptics.tap();
                  preview.retry();
                }}>
                <Text>Try again</Text>
              </Button>
            ) : null}
          </View>
        ) : (
          <FilePreview
            content={preview.textContent || null}
            fileName={sandboxFile.name}
            previewType={preview.previewType}
            blobUrl={preview.blobUrl}
            filePath={sandboxFile.path}
            sandboxUrl={sandboxUrl}
            size={preview.size}
          />
        )}
      </FilePreviewBottomInsetContext.Provider>

      {/* The project drawer's pinned bar: equal cells, default button size,
          floating over a fade of the surface. Download · Add to chat. */}
      <PinnedBar
        controlHeight={BAR_CONTROL_HEIGHT}
        background={pageBackground}
        className="gap-2 px-4">
        <Button
          variant="secondary"
          className="flex-1 rounded-full"
          disabled={!sandboxUrl || downloading || failure?.kind === 'missing'}
          onPress={handleDownload}
          accessibilityLabel={downloading ? 'Downloading' : 'Download file'}>
          {downloading ? <KortixLoader size="small" /> : <Icon as={DownloadSimpleIcon} size={18} />}
          <Text>Download</Text>
        </Button>
        {/* A file that did not load is not offered to the chat either. */}
        {onAdd ? (
          <Button className="flex-1 rounded-full" disabled={failed} onPress={onAdd}>
            <Icon as={PlusIcon} size={18} />
            <Text>Add to chat</Text>
          </Button>
        ) : null}
      </PinnedBar>
    </View>
  );
}
