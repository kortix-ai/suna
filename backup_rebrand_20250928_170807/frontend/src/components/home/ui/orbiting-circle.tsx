'use client';

import { cn } from '@/lib/utils';
import { cubicBezier, HTMLMotionProps, motion, useInView } from 'motion/react';
import React, { useEffect, useRef, useState } from 'react';

export interface OrbitingCirclesProps extends HTMLMotionProps<'div'> {
  className?: string;
  children?: React.ReactNode;
  reverse?: boolean;
  duration?: number;
  delay?: number;
  radius?: number;
  path?: boolean;
  iconSize?: number;
  speed?: number;
  index?: number;
  startAnimationDelay?: number;
  once?: boolean;
}

export function OrbitingCircles({
  className,
  children,
  reverse,
  duration = 20,
  radius = 160,
  path = true,
  iconSize = 30,
  speed = 1,
  index = 0,
  startAnimationDelay = 0,
  once = false,
  ...props
}: OrbitingCirclesProps) {
  const calculatedDuration = duration / speed;

  const ref = useRef(null);
  const isInView = useInView(ref, { once });
  const [shouldAnimate, setShouldAnimate] = useState(false);

  useEffect(() => {
    if (isInView) {
      setShouldAnimate(true);
    } else {
      setShouldAnimate(false);
    }
  }, [isInView]);
  return (
    <>
      {path && (
        <motion.div ref={ref}>
          {shouldAnimate && (
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                duration: 0.8,
                ease: [0.23, 1, 0.32, 1],
                delay: index * 0.2 + startAnimationDelay,
                type: 'spring',
                stiffness: 120,
                damping: 18,
                mass: 1,
              }}
              className="pointer-events-none absolute inset-0"
              style={{
                width: radius * 2,
                height: radius * 2,
                left: `calc(50% - ${radius}px)`,
                top: `calc(50% - ${radius}px)`,
              }}
            >
              <div
                className={cn(
                  'size-full rounded-full',
                  'border border-[0,0,0,0.07] dark:border-[rgba(249,250,251,0.07)]',
                  'bg-gradient-to-b from-[rgba(0,0,0,0.05)] from-0% via-[rgba(249,250,251,0.00)] via-54.76%',
                  'dark:bg-gradient-to-b dark:from-[rgba(249,250,251,0.03)] dark:from-0% dark:via-[rgba(249,250,251,0.00)] dark:via-54.76%',
                  className,
                )}
              />
            </motion.div>
          )}
        </motion.div>
      )}
      {shouldAnimate &&
        React.Children.map(children, (child, index) => {
          const angle = (360 / React.Children.count(children)) * index;
          return (
            <div
              style={
                {
                  '--duration': calculatedDuration,
                  '--radius': radius * 0.98,
                  '--angle': angle,
                  '--icon-size': `${iconSize}px`,
                } as React.CSSProperties
              }
              className={cn(
                'absolute flex size-[var(--icon-size)] z-20 p-1 transform-gpu animate-orbit items-center justify-center rounded-full',
                { '[animation-direction:reverse]': reverse },
              )}
            >
              <motion.div
                key={`orbit-child-${index}`}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{
                  duration: 0.5,
                  delay: 0.6 + index * 0.2 + startAnimationDelay,
                  ease: cubicBezier(0, 0, 0.58, 1),
                  type: 'spring',
                  stiffness: 120,
                  damping: 18,
                  mass: 1,
                }}
                {...props}
              >
                {child}
              </motion.div>
            </div>
          );
        })}
    </>
  );
}
