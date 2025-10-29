'use client';

import React from 'react';
import { cn } from '@/lib/utils';

interface GrainTextProps {
    children: React.ReactNode;
    className?: string;
    grainOpacity?: number;
}

export const GrainText: React.FC<GrainTextProps> = ({
    children,
    className,
    grainOpacity = 10,
}) => {
    return (
        <span className={cn("relative inline-block", className)}>
            {/* Black text underneath */}
            <span
                className="relative z-0"
                style={{ color: 'currentColor' }}
            >
                {children}
            </span>
            {/* Grain text overlay */}
            <span
                className="absolute inset-0 pointer-events-none select-none z-10"
                style={{
                    backgroundImage: `url(/grain-texture.png), linear-gradient(to right, currentColor, currentColor)`,
                    backgroundSize: '60px 60px, 100% 100%',
                    backgroundRepeat: 'repeat, no-repeat',
                    backgroundBlendMode: 'overlay, normal',
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    color: 'transparent',
                    opacity: grainOpacity / 100,
                }}
                aria-hidden="true"
            >
                {children}
            </span>
        </span>
    );
};