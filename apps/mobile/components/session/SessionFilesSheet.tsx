/**
 * SessionFilesSheet — "Recent files": the files this session produced, the
 * list behind web's Outputs card (`lib/session/session-files.ts`). Opens from
 * the thread's Add sheet at full height, with a search field.
 *
 * Two groups: the files the user came for (shown, PDF, spreadsheet, document,
 * deck, page, image, media), then "Other files" (source, config). A row is
 * file glyph · name · kind (no kind on "Other files" rows).
 *
 * A tap opens the file's preview in a second sheet pushed over the list
 * (`FilePreviewSheet`): the file name as the title, `FilePreview` as the body
 * (markdown, HTML, CSV, JSON, code, text, image). A file it does not render —
 * a PDF, an Office file, an archive, media (`previewsInline`) — shows its file
 * card and fetches nothing. Copy (text files) sits at the far right of the
 * title row (`titleTrailing`). Bottom: the project drawer's pinned bar
 * (`PinnedBar`) — two equal cells, default size, floating over a fade of the
 * surface while the document scrolls under them: Download (fetches the file,
 * then the device opens it: Quick Look on iOS, the file type's app on Android;
 * a toast when no app can) · "Add to chat",
 * which closes both sheets and picks the file. A failed load says why — a
 * stopped sandbox keeps its transcript but serves no file — with Try again.
 * Closing the preview returns to the list, search text kept.
 *
 * The body mounts only while the sheet is open: it subscribes to the session's
 * messages, which change on every streamed delta, and the composer around it
 * must not re-render with them.
 */
import * as React from 'react';
import { View } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SandboxFile } from '@/api/types';
import {
  FilePreview,
  FilePreviewBottomInsetContext,
} from '@/components/files/FilePreviewRenderers';
import { useFilePreviewData } from '@/components/files/use-file-preview-data';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { CopyContentButton, KortixBottomSheetModal, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { downloadOpenCodeFileToCache } from '@/lib/files/hooks';
import { openFileOnDevice } from '@/lib/files/open-on-device';
import { previewFailure } from '@/lib/files/preview-failure';
import { haptics } from '@/lib/haptics';
import { THEME } from '@/lib/utils/theme';
import { DownloadSimpleIcon, PlusIcon } from '@/lib/icons';
import { useSyncStore } from '@/lib/opencode/sync-store';
import {
  deriveSessionFiles,
  filterSessionFiles,
  isSupportingFile,
  previewsInline,
  sessionFileKindLabel,
  type SessionFile,
} from '@/lib/session/session-files';
import { showFileTypeIcon } from './tool/shared/show-helpers';

const SNAP_POINTS = ['100%'];
/** `Button` default size (`h-10`): the pinned bar's controls. */
const BAR_CONTROL_HEIGHT = 40;
/** How long Copy shows its check. */

export interface SessionFilesSheetProps {
  sessionId: string | null | undefined;
  /** The session's sandbox: where a file's preview loads from. */
  sandboxUrl: string | undefined;
  /** "Add to chat" in a file's preview. */
  onSelect: (file: SessionFile) => void;
}

export const SessionFilesSheet = React.forwardRef<SheetRef, SessionFilesSheetProps>(
  ({ sessionId, sandboxUrl, onSelect }, ref) => {
    const modalRef = React.useRef<BottomSheetModal>(null);
    const previewRef = React.useRef<BottomSheetModal>(null);
    const insets = useSafeAreaInsets();
    const { colorScheme } = useColorScheme();
    const pageBackground = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;
    const [open, setOpen] = React.useState(false);
    const [previewFile, setPreviewFile] = React.useState<SessionFile | null>(null);
    // The previewed file's text, once it has loaded: what the title row's Copy copies.
    const [copyText, setCopyText] = React.useState('');

    React.useImperativeHandle(ref, () => ({
      open: () => {
        setOpen(true);
        modalRef.current?.present();
      },
      close: () => modalRef.current?.dismiss(),
    }));

    return (
      <>
        <KortixBottomSheetModal
          ref={modalRef}
          title="Recent files"
          snapPoints={SNAP_POINTS}
          enableDynamicSizing={false}
          topInset={insets.top}
          enablePanDownToClose
          onDismiss={() => setOpen(false)}
          keyboardBehavior="extend"
          keyboardBlurBehavior="restore"
          android_keyboardInputMode="adjustResize">
          {open && sessionId ? (
            <SessionFilesBody
              sessionId={sessionId}
              onPreview={(file) => {
                haptics.tap();
                setPreviewFile(file);
                previewRef.current?.present();
              }}
            />
          ) : null}
        </KortixBottomSheetModal>

        {/* Pushed over the list: closing it returns to the list. Only the handle
          and title bar drag this sheet, so a page or a long document scrolls
          inside it. Copy sits at the far right of the title row. */}
        <KortixBottomSheetModal
          ref={previewRef}
          title={previewFile?.name}
          titleTrailing={copyText ? <CopyContentButton text={copyText} /> : undefined}
          stackBehavior="push"
          snapPoints={SNAP_POINTS}
          enableDynamicSizing={false}
          topInset={insets.top}
          enablePanDownToClose
          enableContentPanningGesture={false}
          // The file renderers paint the page background, so this sheet's surface
          // is that colour too: title row, preview, fades and actions are one plane.
          backgroundStyle={{ backgroundColor: pageBackground }}
          onDismiss={() => {
            setPreviewFile(null);
            setCopyText('');
          }}>
          {previewFile ? (
            <FilePreviewBody
              file={previewFile}
              sandboxUrl={sandboxUrl}
              onCopyTextChange={setCopyText}
              onAdd={() => {
                haptics.selection();
                previewRef.current?.dismiss();
                modalRef.current?.dismiss();
                onSelect(previewFile);
              }}
            />
          ) : null}
        </KortixBottomSheetModal>
      </>
    );
  }
);
SessionFilesSheet.displayName = 'SessionFilesSheet';

/** Sandbox paths are absolute; a relative one is workspace-relative (`ToolFilePreviewHost`'s rule). */
function toSandboxFile(file: SessionFile): SandboxFile {
  const path = file.path.startsWith('/') ? file.path : `/workspace/${file.path}`;
  return { name: file.name, path, type: 'file' } as SandboxFile;
}

/** The title row's Copy: the file's text to the clipboard, a check for 1.5 s. */

function FilePreviewBody({
  file,
  sandboxUrl,
  onCopyTextChange,
  onAdd,
}: {
  file: SessionFile;
  sandboxUrl: string | undefined;
  /** The file's text once it has loaded, else ''. */
  onCopyTextChange: (text: string) => void;
  onAdd: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const pageBackground = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;
  const contentInset = usePinnedBarInset(BAR_CONTROL_HEIGHT);
  const toast = useToast();
  const sandboxFile = React.useMemo(() => toSandboxFile(file), [file]);
  // A PDF, an Office file, an archive or media is not rendered here and nothing
  // is fetched for it (Jay, 2026-09-22): the body is its file card.
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
              as={showFileTypeIcon(file.kind, file.name)}
              size={40}
              className="text-muted-foreground"
            />
            <Text variant="large" className="text-center" numberOfLines={2}>
              {file.name}
            </Text>
            <Text variant="muted">{sessionFileKindLabel(file)}</Text>
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

      {/* The project drawer's pinned bar: two equal cells, default button size,
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
        <Button className="flex-1 rounded-full" disabled={failed} onPress={onAdd}>
          <Icon as={PlusIcon} size={18} />
          <Text>Add to chat</Text>
        </Button>
      </PinnedBar>
    </View>
  );
}

function SessionFilesBody({
  sessionId,
  onPreview,
}: {
  sessionId: string;
  onPreview: (file: SessionFile) => void;
}) {
  const insets = useSafeAreaInsets();
  const messages = useSyncStore((s) => s.messages[sessionId]);
  const [query, setQuery] = React.useState('');

  const files = React.useMemo(() => deriveSessionFiles(messages), [messages]);
  const groups = React.useMemo(() => {
    const matches = filterSessionFiles(files, query);
    return [
      { title: null, files: matches.filter((file) => !isSupportingFile(file)) },
      { title: 'Other files', files: matches.filter(isSupportingFile) },
    ].filter((group) => group.files.length > 0);
  }, [files, query]);

  return (
    <BottomSheetScrollView
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        // `PickerSheet`'s layout: 16pt sides, 16pt between blocks.
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: Math.max(insets.bottom, 16) + 8,
        gap: 16,
      }}>
      {files.length > 0 ? (
        <SheetTextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search files"
          accessibilityLabel="Search files"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      ) : null}

      {groups.map((group) => (
        <View key={group.title ?? ''}>
          {group.title ? (
            <Text variant="muted" className="mb-2 px-2">
              {group.title}
            </Text>
          ) : null}
          {/* `bg-secondary`: in dark mode `card` equals the sheet's `popover`. */}
          <SettingsGroup className="bg-secondary">
            {group.files.map((file) => (
              <SettingsRow
                key={file.key}
                icon={showFileTypeIcon(file.kind, file.name)}
                label={file.name}
                // "File" says nothing the glyph does not; only a recognized kind shows.
                value={isSupportingFile(file) ? undefined : sessionFileKindLabel(file)}
                onPress={() => onPreview(file)}
              />
            ))}
          </SettingsGroup>
        </View>
      ))}

      {groups.length === 0 ? (
        <View className="items-center py-6">
          <Text variant="muted">
            {files.length === 0 ? 'No files in this session yet' : 'No matching files'}
          </Text>
        </View>
      ) : null}
    </BottomSheetScrollView>
  );
}
