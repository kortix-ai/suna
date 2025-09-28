import { useTheme } from '@/hooks/useThemeColor';
import React from 'react';
import { StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';

interface CardProps {
    children: React.ReactNode;
    style?: ViewStyle;
    bordered?: boolean;
    elevated?: boolean;
}

interface CardHeaderProps {
    children: React.ReactNode;
    style?: ViewStyle;
    bordered?: boolean;
}

interface CardTitleProps {
    children: React.ReactNode;
    style?: TextStyle;
}

interface CardDescriptionProps {
    children: React.ReactNode;
    style?: TextStyle;
}

interface CardActionProps {
    children: React.ReactNode;
    style?: ViewStyle;
}

interface CardContentProps {
    children: React.ReactNode;
    style?: ViewStyle;
}

interface CardFooterProps {
    children: React.ReactNode;
    style?: ViewStyle;
    bordered?: boolean;
}

function Card({ children, style, bordered = true, elevated = true }: CardProps) {
    const theme = useTheme();

    const cardStyle = StyleSheet.create({
        container: {
            backgroundColor: theme.card,
            borderRadius: 20,
            padding: 24,
            gap: 24,
            ...(bordered && {
                borderWidth: 1,
                borderColor: theme.border,
            }),
        },
    });

    return (
        <View style={[cardStyle.container, style]}>
            {children}
        </View>
    );
}

function CardHeader({ children, style, bordered = false }: CardHeaderProps) {
    const theme = useTheme();

    const headerStyle = StyleSheet.create({
        container: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 12,
            ...(bordered && {
                borderBottomWidth: 1,
                borderBottomColor: theme.border,
                paddingBottom: 24,
            }),
        },
    });

    return (
        <View style={[headerStyle.container, style]}>
            {children}
        </View>
    );
}

function CardTitle({ children, style }: CardTitleProps) {
    const theme = useTheme();

    const titleStyle = StyleSheet.create({
        text: {
            fontSize: 18,
            fontWeight: '600',
            color: theme.foreground,
            lineHeight: 24,
        },
    });

    return (
        <Text style={[titleStyle.text, style]}>
            {children}
        </Text>
    );
}

function CardDescription({ children, style }: CardDescriptionProps) {
    const theme = useTheme();

    const descriptionStyle = StyleSheet.create({
        text: {
            fontSize: 14,
            color: theme.mutedForeground,
            lineHeight: 20,
        },
    });

    return (
        <Text style={[descriptionStyle.text, style]}>
            {children}
        </Text>
    );
}

function CardAction({ children, style }: CardActionProps) {
    const actionStyle = StyleSheet.create({
        container: {
            marginLeft: 'auto',
            alignSelf: 'flex-start',
        },
    });

    return (
        <View style={[actionStyle.container, style]}>
            {children}
        </View>
    );
}

function CardContent({ children, style }: CardContentProps) {
    const contentStyle = StyleSheet.create({
        container: {
            flex: 1,
        },
    });

    return (
        <View style={[contentStyle.container, style]}>
            {children}
        </View>
    );
}

function CardFooter({ children, style, bordered = false }: CardFooterProps) {
    const theme = useTheme();

    const footerStyle = StyleSheet.create({
        container: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            ...(bordered && {
                borderTopWidth: 1,
                borderTopColor: theme.border,
                paddingTop: 24,
            }),
        },
    });

    return (
        <View style={[footerStyle.container, style]}>
            {children}
        </View>
    );
}

export {
    Card, CardAction,
    CardContent, CardDescription, CardFooter, CardHeader,
    CardTitle
};

