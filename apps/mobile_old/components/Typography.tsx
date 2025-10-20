import { fontWeights } from '@/constants/Fonts';
import React from 'react';
import { Text, TextProps } from 'react-native';

interface TypographyProps extends TextProps {
    variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'body' | 'bodySmall' | 'bodyLarge' | 'button' | 'caption' | 'label';
    weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
    size?: number;
}

// Font styles defined directly in the component
const fontStyles = {
    // Headings
    h1: { fontFamily: fontWeights[700], fontSize: 32 },
    h2: { fontFamily: fontWeights[600], fontSize: 28 },
    h3: { fontFamily: fontWeights[600], fontSize: 24 },
    h4: { fontFamily: fontWeights[500], fontSize: 20 },
    h5: { fontFamily: fontWeights[500], fontSize: 18 },
    h6: { fontFamily: fontWeights[500], fontSize: 16 },

    // Body text
    body: { fontFamily: fontWeights[400], fontSize: 16 },
    bodySmall: { fontFamily: fontWeights[400], fontSize: 14 },
    bodyLarge: { fontFamily: fontWeights[400], fontSize: 18 },

    // UI elements
    button: { fontFamily: fontWeights[500], fontSize: 16 },
    caption: { fontFamily: fontWeights[400], fontSize: 12 },
    label: { fontFamily: fontWeights[500], fontSize: 14 },
};

export const Typography: React.FC<TypographyProps> = ({
    children,
    variant = 'body',
    weight,
    size,
    style,
    ...props
}) => {
    let fontStyle = fontStyles[variant];

    // Override with custom weight or size if provided
    if (weight || size) {
        fontStyle = {
            fontFamily: weight ? fontWeights[weight] : fontStyle.fontFamily,
            fontSize: size !== undefined ? size : fontStyle.fontSize,
        };
    }

    return (
        <Text
            style={[fontStyle, style]}
            {...props}
        >
            {children}
        </Text>
    );
};

// Pre-styled typography components for common use cases
export const H1: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="h1" {...props} />
);

export const H2: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="h2" {...props} />
);

export const H3: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="h3" {...props} />
);

export const H4: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="h4" {...props} />
);

export const H5: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="h5" {...props} />
);

export const H6: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="h6" {...props} />
);

export const Body: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="body" {...props} />
);

export const BodySmall: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="bodySmall" {...props} />
);

export const BodyLarge: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="bodyLarge" {...props} />
);

export const Button: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="button" {...props} />
);

export const Caption: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="caption" {...props} />
);

export const Label: React.FC<Omit<TypographyProps, 'variant'>> = (props) => (
    <Typography variant="label" {...props} />
); 