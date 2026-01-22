import { BlurView } from "expo-blur";
import { StyleSheet, Platform, View, Image, useWindowDimensions } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { easeGradient } from "react-native-easing-gradient";

const AuthBackgroundImage = require('@/assets/images/auth.png');

export const ProgressiveBlur = () => {
  const { height, width } = useWindowDimensions();
  const { colors, locations } = easeGradient({
    colorStops: {
      0: { color: 'transparent' },
      0.5: { color: 'rgba(0, 0, 0, 0.99)' },
      1: { color: 'black' },
    },
  });

  return (
    <View style={{ flex: 1 }}>
      <Image
        source={AuthBackgroundImage}
        resizeMode="cover"
        style={{ width: width, height: height }}
      />
      <LinearGradient
        colors={['rgba(0, 0, 0, 0.4)', 'rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.6)']}
        locations={[0, 0.6, 1]}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      />
      <View
        style={{
          width: width,
          height: height / 1.3,
          position: 'absolute',
          bottom: 0,
          zIndex: 2,
        }}
      >
        {Platform.OS === 'ios' ? (
          <MaskedView
            maskElement={
              <LinearGradient
                locations={locations as [number, number, number]}
                colors={colors as [string, string, string]}
                style={StyleSheet.absoluteFill}
              />
            }
            style={StyleSheet.absoluteFill}
          >
            <BlurView
              intensity={100}
              tint="systemChromeMaterialDark"
              style={StyleSheet.absoluteFill}
            />
          </MaskedView>
        ) : (
          <LinearGradient
            colors={['transparent', 'rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.95)']}
            locations={[0, 0.5, 1]}
            style={StyleSheet.absoluteFill}
          />
        )}
      </View>
    </View>
  );
};