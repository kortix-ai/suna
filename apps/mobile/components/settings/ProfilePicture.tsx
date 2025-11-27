import { Image, View } from "react-native";
import { Text } from "@/components/ui/text";

interface ProfilePictureProps {
  imageUrl?: string | null;
  size?: number;
  fallbackText?: string;
}
export const ProfilePicture = ({ imageUrl, size = 32, fallbackText }: ProfilePictureProps) => {
  const hasImage = imageUrl && imageUrl.trim().length > 0;
  
  return (
    <View 
      style={{ width: size * 4, height: size * 4 }}
      className="rounded-full bg-secondary items-center justify-center overflow-hidden"
    >
      {hasImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={{ width: size * 4, height: size * 4 }}
          resizeMode="cover"
        />
      ) : (
        <View className="size-full items-center justify-center bg-primary/10">
          <Text className="text-base font-roobert-semibold text-foreground">
            {fallbackText ? fallbackText.charAt(0).toUpperCase() : '?'}
          </Text>
        </View>
      )}
    </View>
  );
};