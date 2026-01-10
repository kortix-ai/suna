import React from 'react';
import { TextProps } from 'react-native';
import { UITextView } from 'react-native-uitextview';
import { log } from '@/lib/logger';

export interface SelectableUITextProps extends TextProps {
    /**
     * On iOS with selectable=true and uiTextView=true, this becomes a real UITextView.
     * On Android/web or when uiTextView is false, this falls back to React Native's Text.
     */
    uiTextView?: boolean;
    selectable?: boolean;
}

/**
 * Base text primitive that wraps UITextView from react-native-uitextview.
 * 
 * Usage:
 * - Root markdown blocks: <SelectableUIText selectable uiTextView>
 * - Nested spans (bold, italic, links): <SelectableUIText> (no uiTextView prop)
 * 
 * On iOS, root blocks with both props become native UITextView with proper text selection.
 * On Android/web, this automatically falls back to React Native's Text component.
 */
export const SelectableUIText = React.forwardRef<any, SelectableUITextProps>(
    ({ children, ...props }, ref) => {
        log.log('[SelectableUIText] Props:', {
            hasChildren: !!children,
            childrenType: typeof children,
            isArray: Array.isArray(children),
            childrenCount: React.Children.count(children),
            props: Object.keys(props),
            selectable: props.selectable,
            uiTextView: props.uiTextView,
        });

        if (React.Children.count(children) > 0) {
            const firstChild = React.Children.toArray(children)[0];
            log.log('[SelectableUIText] First child:', {
                type: typeof firstChild,
                isReactElement: React.isValidElement(firstChild),
                value: typeof firstChild === 'string' ? firstChild.substring(0, 50) : 'not a string',
            });
        }

        return (
            <UITextView ref={ref} {...props}>
                {children}
            </UITextView>
        );
    }
);

SelectableUIText.displayName = 'SelectableUIText';
