import { Image, View } from "react-native";
import { Text } from "@/components/ui/text";

interface ProfilePictureProps {
  imageUrl?: string | null;
  /** Tailwind spacing units: the rendered size is `size * 4` points. */
  size?: number;
  fallbackText?: string;
}
export const ProfilePicture = ({ imageUrl, size = 32, fallbackText }: ProfilePictureProps) => {
  const hasImage = imageUrl && imageUrl.trim().length > 0;
  const points = size * 4;

  return (
    <View
      style={{ width: points, height: points }}
      className="rounded-full bg-secondary items-center justify-center overflow-hidden"
    >
      {hasImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={{ width: points, height: points }}
          resizeMode="cover"
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
