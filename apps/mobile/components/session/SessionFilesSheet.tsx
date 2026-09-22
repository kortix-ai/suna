/**
 * SessionFilesSheet — "Recent files": the files this session produced, the
 * list behind web's Outputs card (`lib/session/session-files.ts`). Opens from
 * the thread's Add sheet at full height, with a search field.
 *
 * Two groups: the files the user came for (shown, PDF, spreadsheet, document,
 * deck, page, image, media), then "Other files" (source, config). A row is
 * file glyph · name · kind (no kind on "Other files" rows).
 *
 * A tap opens the file's preview in the app's one file sheet, pushed over the
 * list (`components/files/FilePreviewSheet`): the file name as the title, the
 * document as the body
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

import { FilePreviewSheet } from '@/components/files/FilePreviewSheet';
import { KortixBottomSheetModal, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { THEME } from '@/lib/utils/theme';
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
    const previewSheetRef = React.useRef<SheetRef>(null);
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
                previewSheetRef.current?.open();
              }}
            />
          ) : null}
        </KortixBottomSheetModal>

        {/* Pushed over the list: closing it returns to the list. The one file
          preview of the app (`FilePreviewSheet`), the same sheet a tool row
          opens. */}
        <FilePreviewSheet
          ref={previewSheetRef}
          file={previewFile}
          sandboxUrl={sandboxUrl}
          pushed
          onAdd={() => {
            modalRef.current?.dismiss();
            if (previewFile) onSelect(previewFile);
          }}
          onDismiss={() => setPreviewFile(null)}
        />
      </>
    );
  }
);
SessionFilesSheet.displayName = 'SessionFilesSheet';

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
          <SettingsGroup>
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
