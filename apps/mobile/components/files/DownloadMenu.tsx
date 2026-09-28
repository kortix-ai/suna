/**
 * DownloadMenu — one Download control for every file surface (KRTX-605).
 *
 * A markdown file's Download opens a menu anchored to the control: Markdown
 * (the file itself) · PDF. Every other file downloads on tap, as before. The
 * caller keeps its own control and hand-off (share sheet or the device's
 * app); `children` receives the press handler to give that control.
 *
 * The menu is the RNR `context-menu` opened from the control's tap
 * (`relativeTo="trigger"`), the user message menu's pattern.
 */
import * as React from 'react';
import { View } from 'react-native';
import type { TriggerRef } from '@rn-primitives/context-menu';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { downloadFormats, type DownloadFormat } from '@/lib/files/markdown-export';
import { haptics } from '@/lib/haptics';
import { FileMdIcon, FilePdfIcon } from '@/lib/icons';
import { OVERLAY_PORTAL_HOST } from '@/lib/ui/portal-hosts';

export function DownloadMenu({
  fileName,
  pdfReady,
  onDownload,
  side = 'top',
  portalHost = OVERLAY_PORTAL_HOST,
  className,
  children,
}: {
  fileName: string;
  /** The PDF is made from the loaded text: false until it has loaded. */
  pdfReady: boolean;
  onDownload: (format: DownloadFormat) => void;
  /** Where the menu opens: above a bottom bar, below a header. */
  side?: 'top' | 'bottom';
  /** A native `Modal` passes its own host; the default draws above bottom sheets. */
  portalHost?: string;
  /** Layout of the control's wrapper, e.g. `flex-1` in a bar of equal cells. */
  className?: string;
  children: (onPress: () => void) => React.ReactNode;
}) {
  const menuRef = React.useRef<TriggerRef>(null);

  if (downloadFormats(fileName).length === 1) {
    return <View className={className}>{children(() => onDownload('file'))}</View>;
  }

  return (
    <ContextMenu relativeTo="trigger" asChild>
      <View className={className}>
        {/* The trigger only measures the control: the control's tap opens the menu. */}
        <ContextMenuTrigger ref={menuRef} asChild>
          <View>
            {children(() => {
              haptics.selection();
              menuRef.current?.open();
            })}
          </View>
        </ContextMenuTrigger>
        <ContextMenuContent
          side={side}
          align="end"
          sideOffset={6}
          className="min-w-44"
          portalHost={portalHost}>
          <ContextMenuItem onPress={() => onDownload('file')}>
            <Icon as={FileMdIcon} size={16} className="text-foreground" />
            <Text>Markdown</Text>
          </ContextMenuItem>
          <ContextMenuItem disabled={!pdfReady} onPress={() => onDownload('pdf')}>
            <Icon as={FilePdfIcon} size={16} className="text-foreground" />
            <Text>PDF</Text>
          </ContextMenuItem>
        </ContextMenuContent>
      </View>
    </ContextMenu>
  );
}
