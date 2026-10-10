/**
 * PastedTextSheet — a "Pasted text" tile's full text (a sent message's tile,
 * a composer's tile). The sheet Recent files opens (`FilePreviewSheet`), cut
 * down (Jay): close at the left, "Pasted text" centred, Copy at the right,
 * the text as the body. No pinned bar: the text is already in the chat, so
 * there is nothing to download or add.
 *
 * Mounted once in `app/_layout.tsx`; `openPastedText` (stores/pasted-text-store)
 * opens it, and its close clears the store.
 */
import * as React from 'react';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilePreviewBottomInsetContext, TextPreview } from '@/components/files/FilePreviewRenderers';
import { CopyContentButton, KortixBottomSheetModal } from '@/components/kortix/sheet';
import { THEME } from '@/lib/utils/theme';
import { usePastedTextStore } from '@/stores/pasted-text-store';

const SNAP_POINTS = ['100%'];

export function PastedTextSheet() {
  const text = usePastedTextStore((s) => s.text);
  const close = usePastedTextStore((s) => s.close);
  const modalRef = React.useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const pageBackground = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;

  // The store is the source of truth: a tile's tap sets the text, which opens
  // the sheet; the sheet's close clears it.
  React.useEffect(() => {
    if (text !== null) modalRef.current?.present();
  }, [text]);

  return (
    <KortixBottomSheetModal
      ref={modalRef}
      title="Pasted text"
      titleTrailing={text ? <CopyContentButton text={text} label="Copy pasted text" /> : undefined}
      snapPoints={SNAP_POINTS}
      enableDynamicSizing={false}
      topInset={insets.top}
      enablePanDownToClose
      enableContentPanningGesture={false}
      backgroundStyle={{ backgroundColor: pageBackground }}
      onDismiss={close}>
      {text !== null ? (
        <FilePreviewBottomInsetContext.Provider value={insets.bottom}>
          <TextPreview content={text} />
        </FilePreviewBottomInsetContext.Provider>
      ) : null}
    </KortixBottomSheetModal>
  );
}
