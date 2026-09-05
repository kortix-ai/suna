import { THEME } from "@/lib/utils/theme";
import { cn } from "@/lib/utils";
import { useColorScheme } from "nativewind";
import { LinearGradient } from "expo-linear-gradient";
import * as React from "react";
import { ScrollView, View, type ScrollViewProps } from "react-native";

const EDGE_EPS = 2;

export type FadedScrollViewProps = Omit<ScrollViewProps, "horizontal"> & {
  orientation: "horizontal" | "vertical";
  /** Cross-axis thickness of each fade (horizontal → left/right width; vertical → top/bottom height). */
  fadeSize?: number;
  containerClassName?: string;
};

const FadedScrollView = React.forwardRef<ScrollView, FadedScrollViewProps>(function FadedScrollView(
  {
    orientation,
    fadeSize = 28,
    containerClassName,
    className,
    onScroll,
    onLayout,
    onContentSizeChange,
    scrollEventThrottle,
    children,
    ...scrollProps
  },
  ref,
) {
  const { colorScheme } = useColorScheme();
  const surface = THEME[colorScheme === "dark" ? "dark" : "light"].background;

  const [metrics, setMetrics] = React.useState({
    contentW: 0,
    contentH: 0,
    layoutW: 0,
    layoutH: 0,
    x: 0,
    y: 0,
  });

  const isHorizontal = orientation === "horizontal";

  const overflowH = metrics.contentW > metrics.layoutW + 1;
  const overflowV = metrics.contentH > metrics.layoutH + 1;

  const showStartFade = isHorizontal
    ? overflowH && metrics.x > EDGE_EPS
    : overflowV && metrics.y > EDGE_EPS;

  const showEndFade = isHorizontal
    ? overflowH && metrics.x < metrics.contentW - metrics.layoutW - EDGE_EPS
    : overflowV && metrics.y < metrics.contentH - metrics.layoutH - EDGE_EPS;

  return (
    <View className={cn("relative", containerClassName)}>
      <ScrollView
        ref={ref}
        horizontal={isHorizontal}
        {...scrollProps}
        className={className}
        scrollEventThrottle={scrollEventThrottle ?? 16}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setMetrics((m) => ({ ...m, layoutW: width, layoutH: height }));
          onLayout?.(e);
        }}
        onContentSizeChange={(w, h) => {
          setMetrics((m) => ({ ...m, contentW: w, contentH: h }));
          onContentSizeChange?.(w, h);
        }}
        onScroll={(e) => {
          const { x, y } = e.nativeEvent.contentOffset;
          setMetrics((m) => ({ ...m, x, y }));
          onScroll?.(e);
        }}
      >
        {children}
      </ScrollView>

      {isHorizontal ? (
        <>
          {showStartFade ? (
            <LinearGradient
              pointerEvents="none"
              colors={[surface, "transparent"]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: fadeSize,
              }}
            />
          ) : null}
          {showEndFade ? (
            <LinearGradient
              pointerEvents="none"
              colors={["transparent", surface]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{
                position: "absolute",
                right: 0,
                top: 0,
                bottom: 0,
                width: fadeSize,
              }}
            />
          ) : null}
        </>
      ) : (
        <>
          {showStartFade ? (
            <LinearGradient
              pointerEvents="none"
              colors={[surface, "transparent"]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                height: fadeSize,
              }}
            />
          ) : null}
          {showEndFade ? (
            <LinearGradient
              pointerEvents="none"
              colors={["transparent", surface]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: fadeSize,
              }}
            />
          ) : null}
        </>
      )}
    </View>
  );
});

export { FadedScrollView };
