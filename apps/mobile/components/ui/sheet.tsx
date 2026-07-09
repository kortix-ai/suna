// apps/mobile/components/ui/sheet.tsx
import * as React from 'react';
import { View, Dimensions } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { getSheetBg } from '@/lib/theme-colors';
import { Text } from './text';
import { cn } from '@/lib/utils/utils';

export interface SheetRef { open: () => void; close: () => void; }
interface SheetProps {
  snapPoints?: (string | number)[];
  /** Present at full screen height (100%) with a safe-area top inset. */
  fullScreen?: boolean;
  /** Opt in to swipe-down-to-dismiss. Off by default, matching gorhom. */
  enablePanDownToClose?: boolean;
  onDismiss?: () => void;
  children: React.ReactNode;
}

export const Sheet = React.forwardRef<SheetRef, SheetProps>(
  ({ snapPoints, fullScreen, enablePanDownToClose, onDismiss, children }, ref) => {
    const modalRef = React.useRef<BottomSheetModal>(null);
    const insets = useSafeAreaInsets();
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));
    const renderBackdrop = React.useCallback(
      (p: any) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.5} />,
      []
    );
    const effectiveSnapPoints = fullScreen ? ['100%'] : snapPoints;
    return (
      <BottomSheetModal
        ref={modalRef}
        snapPoints={effectiveSnapPoints}
        enableDynamicSizing={!effectiveSnapPoints}
        enablePanDownToClose={enablePanDownToClose}
        topInset={fullScreen ? insets.top : 0}
        onDismiss={onDismiss}
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        handleIndicatorStyle={{ backgroundColor: isDark ? '#3A3A3A' : '#D4D4D4' }}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark), borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
        <BottomSheetView style={fullScreen ? { flex: 1 } : undefined}>
          {fullScreen ? (
            // BottomSheetView content-sizes, so a concrete min-height is what
            // lets inner `flex-1` regions expand and pin content to the bottom.
            <View
              style={{
                flex: 1,
                minHeight: Dimensions.get('window').height - insets.top - insets.bottom - 20,
              }}>
              {children}
            </View>
          ) : (
            children
          )}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);
Sheet.displayName = 'Sheet';

function Header({ title, className }: { title?: string; className?: string }) {
  return <View className={cn('px-5 pt-1 pb-3', className)}>{title ? <Text className="font-roobert-semibold text-lg text-foreground">{title}</Text> : null}</View>;
}
function Body({ children, className }: { children: React.ReactNode; className?: string }) {
  return <View className={cn('px-5 pb-6', className)}>{children}</View>;
}
function Footer({ children, className }: { children: React.ReactNode; className?: string }) {
  return <View className={cn('px-5 pb-8 pt-2 flex-row gap-3', className)}>{children}</View>;
}
(Sheet as any).Header = Header;
(Sheet as any).Body = Body;
(Sheet as any).Footer = Footer;
export { Header as SheetHeader, Body as SheetBody, Footer as SheetFooter };
