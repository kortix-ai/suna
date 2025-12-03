'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { DynamicIcon } from 'lucide-react/dynamic';

interface GrainIconProps {
    iconName: string;
    className?: string;
    backgroundColor?: string;
    borderColor?: string;
    grainOpacity?: number;
}

export const GrainIcon: React.FC<GrainIconProps> = ({
    iconName,
    className,
    backgroundColor = '#FFAFAF',
    borderColor = '#F19C9C',
    grainOpacity = 15,
}) => {
    return (
        <div
            className={cn("w-10 h-10 relative rounded-2xl overflow-hidden", className)}
            style={{
                backgroundColor,
                outline: `1.50px solid ${borderColor}`,
                outlineOffset: '-1.50px',
            }}
        >
            {/* Icon */}
            <div className="w-5 h-5 left-[10px] top-[10px] absolute text-black">
                <DynamicIcon
                    name={iconName as any}
                    className="w-5 h-5"
                    strokeWidth={2}
                />
            </div>

            {/* Grain overlay */}
            <div
                className="absolute inset-0 pointer-events-none select-none rounded-2xl"
                style={{
                    backgroundImage: `url(/grain-texture.png)`,
                    backgroundSize: '60px 60px',
                    backgroundRepeat: 'repeat',
                    opacity: grainOpacity / 100,
                    mixBlendMode: 'overlay',
                }}
                aria-hidden="true"
            />
        </div>
    );
};
