// apps/mobile/components/session/ToolsMenuSheet.tsx
import * as React from 'react';
import { View } from 'react-native';
import {
  FolderOpen,
  Terminal as TerminalIcon,
  Compass,
  Bot,
  History,
  Pencil,
  Share2,
  Download,
} from 'lucide-react-native';
import { Sheet, SheetHeader, SheetBody, type SheetRef } from '@/components/ui/sheet';
import { ListRow } from '@/components/ui/list-row';
import { Icon } from '@/components/ui/icon';
import { useTabStore } from '@/stores/tab-store';

interface ToolsMenuSheetProps {
  onRename?: () => void;
  onShare?: () => void;
  onExport?: () => void;
}

export const ToolsMenuSheet = React.forwardRef<SheetRef, ToolsMenuSheetProps>((props, ref) => {
  const innerSheetRef = React.useRef<SheetRef>(null);

  React.useImperativeHandle(ref, () => ({
    open: () => innerSheetRef.current?.open(),
    close: () => innerSheetRef.current?.close(),
  }));

  const navigateToPage = React.useCallback((pageId: string) => {
    innerSheetRef.current?.close();
    useTabStore.getState().navigateToPage(pageId);
  }, []);

  const openSessionHistory = React.useCallback(() => {
    innerSheetRef.current?.close();
    useTabStore.getState().setShowTabsOverview(true);
  }, []);

  const handleRename = React.useCallback(() => {
    innerSheetRef.current?.close();
    props.onRename?.();
  }, [props.onRename]);

  const handleShare = React.useCallback(() => {
    innerSheetRef.current?.close();
    props.onShare?.();
  }, [props.onShare]);

  const handleExport = React.useCallback(() => {
    innerSheetRef.current?.close();
    props.onExport?.();
  }, [props.onExport]);

  return (
    <Sheet ref={innerSheetRef}>
      <SheetHeader title="Tools" />
      <SheetBody className="px-0 pb-2">
        <View>
          <ListRow
            title="Files"
            left={<Icon as={FolderOpen} size={18} className="text-foreground" />}
            onPress={() => navigateToPage('page:files')}
          />
          <ListRow
            title="Terminal"
            left={<Icon as={TerminalIcon} size={18} className="text-foreground" />}
            onPress={() => navigateToPage('page:terminal')}
          />
          <ListRow
            title="Browser"
            left={<Icon as={Compass} size={18} className="text-foreground" />}
            onPress={() => navigateToPage('page:browser')}
          />
          <ListRow
            title="Agents"
            left={<Icon as={Bot} size={18} className="text-foreground" />}
            onPress={() => navigateToPage('page:agents')}
          />
          <ListRow
            title="Session history"
            left={<Icon as={History} size={18} className="text-foreground" />}
            onPress={openSessionHistory}
          />
          <ListRow
            title="Rename"
            left={<Icon as={Pencil} size={18} className="text-foreground" />}
            onPress={handleRename}
          />
          <ListRow
            title="Share"
            left={<Icon as={Share2} size={18} className="text-foreground" />}
            onPress={handleShare}
          />
          <ListRow
            title="Export transcript"
            left={<Icon as={Download} size={18} className="text-foreground" />}
            onPress={handleExport}
            divider={false}
          />
        </View>
      </SheetBody>
    </Sheet>
  );
});
ToolsMenuSheet.displayName = 'ToolsMenuSheet';
