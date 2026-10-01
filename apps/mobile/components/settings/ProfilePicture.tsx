import * as React from "react";
import { Image, View } from "react-native";
import { Text } from "@/components/ui/text";
import { resolveLocalUrl } from "@/lib/utils/resolve-local-url";

interface ProfilePictureProps {
  imageUrl?: string | null;
  /** Tailwind spacing units: the rendered size is `size * 4` points. */
  size?: number;
  fallbackText?: string;
}
export const ProfilePicture = ({ imageUrl, size = 32, fallbackText }: ProfilePictureProps) => {
  const url = imageUrl?.trim() ?? '';
  const points = size * 4;
  // A photo that fails to load shows the initial, not an empty circle.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  // A local-stack photo is stored as `http://127.0.0.1:54321/…`; on a phone
  // that is the phone. Remap only for display: the stored URL is untouched.
  const source = React.useMemo(() => (url ? { uri: resolveLocalUrl(url) } : null), [url]);
  const showImage = source && failedUrl !== url;

  return (
    <View
      style={{ width: points, height: points }}
      className="rounded-full bg-secondary items-center justify-center overflow-hidden"
    >
      {showImage ? (
        <Image
          source={source}
          style={{ width: points, height: points }}
          resizeMode="cover"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <View className="size-full items-center justify-center bg-primary/10">
          {/* The initial scales with the circle: an 80pt avatar gets an h3 letter. */}
          <Text variant={points >= 64 ? 'h3' : 'large'}>
            {fallbackText ? fallbackText.charAt(0).toUpperCase() : '?'}
          </Text>
        </View>
      )}
    </View>
  );
};
