"use client";

import { colorWithOpacity, getRGBA } from "@/lib/utils";
import NumberFlow from "@number-flow/react";
import { motion, useInView } from "motion/react";
import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";

interface LineChartProps {
  data: number[];
  height?: number;
  width?: number;
  color: string;
  shouldAnimate: boolean;
  startAnimationDelay?: number;
}

export function LineChart({
  data,
  height = 200,
  width = 600,
  color,
  shouldAnimate,
  startAnimationDelay,
}: LineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Create smooth curve points using bezier curves
  const createSmoothPath = (points: { x: number; y: number }[]) => {
    if (points.length < 2) return "";

    const path = points.reduce((acc, point, i, arr) => {
      if (i === 0) {
        // Move to the first point
        return `M ${point.x} ${point.y}`;
      }

      // Calculate control points for smooth curve
      const prev = arr[i - 1];
      const next = arr[i + 1];
      const smoothing = 0.2;

      // If it's the last point, we don't need a curve
      if (i === arr.length - 1) {
        return `${acc} L ${point.x} ${point.y}`;
      }

      // Calculate control points
      const cp1x = prev.x + (point.x - prev.x) * smoothing;
      const cp1y = prev.y + (point.y - prev.y) * smoothing;
      const cp2x = point.x - (next.x - prev.x) * smoothing;
      const cp2y = point.y - (next.y - prev.y) * smoothing;

      return `${acc} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${point.x},${point.y}`;
    }, "");

    return path;
  };

  // Convert data points to coordinates
  const coordinates = data.map((value, index) => ({
    x: (index / (data.length - 1)) * width,
    y: height - (value / Math.max(...data)) * height * 0.8, // Add some padding at top
  }));

  // Create smooth path
  const smoothPath = createSmoothPath(coordinates);

  // Find the middle point coordinates
  const middleIndex = Math.floor(data.length / 2);
  const middlePoint = coordinates[middleIndex];

  const [showPulse, setShowPulse] = useState(false);

  useEffect(() => {
    if (!shouldAnimate) {
      setShowPulse(false);
      return;
    }

    const timeoutId = setTimeout(() => {
      setShowPulse(true);
    }, (startAnimationDelay || 0) * 1000);

    return () => clearTimeout(timeoutId);
  }, [shouldAnimate, startAnimationDelay]);

  const [computedColor, setComputedColor] = useState(color);

  useEffect(() => {
    setComputedColor(getRGBA(color));
  }, [color]);

  const getColorWithOpacity = useCallback(
    (opacity: number) => colorWithOpacity(computedColor, opacity),
    [computedColor],
  );

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Gradient Definition */}
      <defs>
        <linearGradient id="lineGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={getColorWithOpacity(0.3)} />
          <stop offset="100%" stopColor={getColorWithOpacity(0)} />
        </linearGradient>
      </defs>

      {/* Animated Area Fill */}
      <motion.path
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{
          opacity: shouldAnimate ? 1 : 0,
          scale: shouldAnimate ? 1 : 0.95,
        }}
        transition={{
          duration: 0.8,
          ease: "easeOut",
          delay: startAnimationDelay,
        }}
        d={`${smoothPath} L ${width},${height} L 0,${height} Z`}
        fill="url(#lineGradient)"
      />

      {/* Animated Line */}
      <motion.path
        initial={{ pathLength: 0 }}
        animate={{ pathLength: shouldAnimate ? 1 : 0 }}
        transition={{
          duration: 1.5,
          ease: "easeInOut",
          delay: startAnimationDelay,
        }}
        d={smoothPath}
        stroke={color}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />

      {/* Center dot with scale animation */}
      <motion.circle
        cx={middlePoint.x}
        cy={middlePoint.y}
        r="4"
        fill={color}
        initial={{ scale: 0, opacity: 0 }}
        animate={{
          scale: shouldAnimate ? 1 : 0,
          opacity: shouldAnimate ? 1 : 0,
        }}
        transition={{
          delay: startAnimationDelay ? startAnimationDelay + 0.3 : 0.3,
          duration: 0.4,
          ease: "backOut",
        }}
      />

      {/* Multiple pulsing waves */}
      {showPulse && (
        <>
          {[0, 1, 2].map((index) => (
            <motion.circle
              key={index}
              cx={middlePoint.x}
              cy={middlePoint.y}
              r="10"
              stroke={color}
              strokeWidth="2"
              fill="none"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{
                scale: [0.5, 2],
                opacity: [0.8, 0],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                delay: index * 0.67,
                ease: "easeOut",
                times: [0, 1],
                repeatDelay: 0,
              }}
            />
          ))}
        </>
      )}
    </svg>
  );
}

export function NumberFlowCounter({
  toolTipValues,
  shouldAnimate,
  startAnimationDelay,
}: {
  toolTipValues: number[];
  shouldAnimate: boolean;
  startAnimationDelay?: number;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentValue = toolTipValues[currentIndex];
  const [showCounter, setShowCounter] = useState(false);

  useEffect(() => {
    if (!shouldAnimate) {
      setShowCounter(false);
      return;
    }

    const timeoutId = setTimeout(() => {
      setShowCounter(true);
    }, (startAnimationDelay || 0) * 1000);

    return () => clearTimeout(timeoutId);
  }, [shouldAnimate, startAnimationDelay]);

  useEffect(() => {
    if (!showCounter) return;

    const intervalId = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % toolTipValues.length);
    }, 2000);

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [showCounter, toolTipValues.length]);

  return (
    <div
      className={`${
        showCounter ? "opacity-100" : "opacity-0"
      } transition-opacity duration-300 ease-in-out absolute top-32 left-[42%] -translate-x-1/2 text-sm bg-[#1A1B25] border border-white/[0.07] text-white px-4 py-1 rounded-full h-8 flex items-center justify-center font-mono shadow-[0px_1.1px_0px_0px_rgba(255,255,255,0.20)_inset,0px_4.4px_6.6px_0px_rgba(255,255,255,0.01)_inset,0px_2.2px_6.6px_0px_rgba(18,43,105,0.04),0px_1.1px_2.2px_0px_rgba(18,43,105,0.08),0px_0px_0px_1.1px_rgba(18,43,105,0.08)]`}
    >
      <NumberFlow
        value={currentValue}
        className="font-mono"
        transformTiming={{
          duration: 700,
          easing: "ease-out",
        }}
        format={{
          useGrouping: true,
          minimumIntegerDigits: 1,
        }}
      />
    </div>
  );
}

export function ThirdBentoAnimation({
  data,
  toolTipValues,
  color = "var(--secondary)",
  startAnimationDelay = 0,
  once = false,
}: {
  data: number[];
  toolTipValues: number[];
  color?: string;
  startAnimationDelay?: number;
  once?: boolean;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once });
  const [shouldAnimate, setShouldAnimate] = useState(false);
  const [computedColor, setComputedColor] = useState(color);

  useEffect(() => {
    setComputedColor(getRGBA(color));
  }, [color]);

  useEffect(() => {
    if (isInView) {
      setShouldAnimate(true);
    } else {
      setShouldAnimate(false);
    }
  }, [isInView]);

  return (
    <div
      ref={ref}
      className="relative flex size-full items-center justify-center h-[300px] pt-10 overflow-hidden"
      style={
        {
          "--color": computedColor,
        } as CSSProperties
      }
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: shouldAnimate ? 1 : 0 }}
        transition={{
          duration: 0.5,
          delay: startAnimationDelay ? startAnimationDelay + 0.3 : 0.3,
          ease: "easeOut",
        }}
        className="absolute top-[60%] left-1/2 -translate-x-1/2 w-[2px] h-32 bg-gradient-to-b from-[var(--color)] to-[var(--color-transparent)]"
      ></motion.div>
      <NumberFlowCounter
        toolTipValues={toolTipValues}
        shouldAnimate={shouldAnimate}
        startAnimationDelay={startAnimationDelay}
      />
      <LineChart
        data={data}
        height={200}
        width={600}
        color={computedColor}
        shouldAnimate={shouldAnimate}
        startAnimationDelay={startAnimationDelay}
      />
    </div>
  );
}
