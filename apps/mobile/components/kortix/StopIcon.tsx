import * as React from 'react';
import Svg, { Rect } from 'react-native-svg';
import type { SvgProps } from 'react-native-svg';
import { cssInterop } from 'nativewind';

interface StopIconProps extends SvgProps {
    size?: number;
}

const StopIconBase = ({ size = 24, ...props }: StopIconProps) => {
    return (
        <Svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            {...props}
        >
            <Rect
                x="5"
                y="5"
                width="14"
                height="14"
                rx="5"
                fill="currentColor"
            />
        </Svg>
    );
};

cssInterop(StopIconBase, {
    className: {
        target: 'style',
        nativeStyleToProp: { color: true },
    },
});

export const StopIcon = StopIconBase;
