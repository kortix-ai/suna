import { cn } from "@/lib/utils";
import React from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { SafeAreaView as RNFSafeAreaView } from "react-native-safe-area-context";

const SafeAreaView = ({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
}) => {
  return (
    <RNFSafeAreaView className={cn("relative flex-1 bg-background", className)} style={style}>
      {children}
    </RNFSafeAreaView>
  );
};

export default SafeAreaView;
