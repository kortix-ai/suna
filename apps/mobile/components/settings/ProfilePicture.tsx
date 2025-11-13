import { Image, View } from "react-native";

interface ProfilePictureProps {
  imageUrl: string;
  size?: number;
}
export const ProfilePicture = ({ imageUrl, size = 32 }: ProfilePictureProps) => {
  return (
    <View 
      style={{ width: size * 4, height: size * 4 }}
      className="rounded-full bg-secondary items-center justify-center overflow-hidden"
    >
     <Image
       source={{ uri: imageUrl }}
       style={{ width: size * 4, height: size * 4 }}
       resizeMode="cover"
      />
    </View>
  );
};