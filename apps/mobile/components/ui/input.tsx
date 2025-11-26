import * as React from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { Text } from './text';
import { cn } from '@/lib/utils/utils';

export interface InputProps extends Omit<TextInputProps, 'className'> {
    /**
     * Current input value
     */
    value: string;

    /**
     * Callback when text changes
     */
    onChangeText: (text: string) => void;

    /**
     * Placeholder text
     */
    placeholder?: string;

    /**
     * Error message to display below input
     */
    error?: string;

    /**
     * Label text to display above input
     */
    label?: string;

    /**
     * Size variant
     */
    size?: 'default' | 'lg';

    /**
     * Additional className for the container
     */
    containerClassName?: string;

    /**
     * Additional className for the input wrapper
     */
    wrapperClassName?: string;

    /**
     * Additional className for the input itself
     */
    inputClassName?: string;
}

/**
 * Input Component
 * 
 * Reusable text input component with consistent styling
 * - Supports labels and error messages
 * - Customizable styling via className props
 * - Consistent design system integration
 * 
 * Default Specifications:
 * - Height: 48px (h-12)
 * - Border radius: 16px (rounded-2xl)
 * - Background: bg-muted/5
 * - Border: border-border/40
 * - Font: Roobert-Regular
 */
export const Input = React.forwardRef<TextInput, InputProps>(
    (
        {
            value,
            onChangeText,
            placeholder,
            error,
            label,
            size = 'default',
            containerClassName,
            wrapperClassName,
            inputClassName,
            secureTextEntry = false,
            autoCapitalize = 'none',
            autoCorrect = false,
            keyboardType = 'default',
            returnKeyType = 'done',
            ...props
        },
        ref
    ) => {
        const height = size === 'lg' ? 56 : 48;
        const paddingX = size === 'lg' ? 5 : 4;
        const fontSize = size === 'lg' ? 16 : 15;

        return (
            <View className={cn('w-full', containerClassName)}>
                {label && (
                    <Text className="text-sm font-roobert-medium text-muted-foreground mb-3 uppercase tracking-wider">
                        {label}
                    </Text>
                )}

                <View
                    className={cn(
                        'bg-border/40 rounded-2xl justify-center',
                        error && 'border-destructive',
                        wrapperClassName
                    )}
                >
                    <TextInput
                        ref={ref}
                        value={value}
                        onChangeText={onChangeText}
                        placeholder={placeholder}
                        placeholderTextColor="hsl(var(--muted-foreground) / 0.5)"
                        secureTextEntry={secureTextEntry}
                        autoCapitalize={autoCapitalize}
                        autoCorrect={autoCorrect}
                        keyboardType={keyboardType}
                        returnKeyType={returnKeyType}
                        style={{
                            fontFamily: 'Roobert-Regular',
                            height,
                            paddingHorizontal: paddingX * 4,
                            paddingVertical: 0,
                            paddingTop: 0,
                            paddingBottom: 0,
                            fontSize,
                            lineHeight: 20,
                            textAlignVertical: 'center',
                            includeFontPadding: false
                        }}
                        className={cn(
                            'text-foreground',
                            inputClassName
                        )}
                        {...props}
                    />
                </View>

                {error && (
                    <Text className="text-destructive text-sm font-roobert mt-2 px-1">
                        {error}
                    </Text>
                )}
            </View>
        );
    }
);

Input.displayName = 'Input';
