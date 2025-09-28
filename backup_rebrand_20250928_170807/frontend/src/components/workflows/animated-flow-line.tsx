'use client';

import React from 'react';
import { motion } from 'framer-motion';

interface AnimatedFlowLineProps {
    isAnimating?: boolean;
    className?: string;
}

export function AnimatedFlowLine({ isAnimating = false, className = '' }: AnimatedFlowLineProps) {
    return (
        <div className={`relative flex items-center justify-center h-4 ${className}`}>
            {/* Simple dashed line */}
            <motion.div
                className="w-0.5 h-full rounded-full border-l border-dashed border-primary/50"
                style={{
                    background: isAnimating
                        ? 'repeating-linear-gradient(to bottom, #4461FF 0px, #4461FF 2px, transparent 2px, transparent 4px)'
                        : undefined,
                    borderLeft: isAnimating ? 'none' : undefined
                }}
                animate={isAnimating ? {
                    backgroundPosition: ['0px 0px', '0px 12px']
                } : {}}
                transition={{
                    duration: 0.8,
                    repeat: isAnimating ? Infinity : 0,
                    ease: "linear"
                }}
            />
        </div>
    );
} 