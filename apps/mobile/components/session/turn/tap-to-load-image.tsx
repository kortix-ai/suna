import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { formatMegabytes } from '@/lib/session/image-load';

export function TapToLoadImage({
  sizeBytes,
  height,
  isDark,
  onLoad,
}: {
  sizeBytes: number | null;
  height: number;
  isDark: boolean;
  onLoad: () => void;
}) {
  return (
    <View style={{ height, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.03) : withAlpha(THEME.light.foreground, 0.02) }}>
      <Button variant="secondary" size="sm" onPress={onLoad}>
        <Text>{sizeBytes !== null ? `Tap to load (${formatMegabytes(sizeBytes)})` : 'Tap to load'}</Text>
      </Button>
    </View>
  );
}
