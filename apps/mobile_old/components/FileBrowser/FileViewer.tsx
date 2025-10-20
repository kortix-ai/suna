import { isImageFile, isTextFile } from '@/api/sandbox-file-api';
import { Body } from '@/components/Typography';
import { useFileContent } from '@/hooks/useFileBrowserHooks';
import { useImageContent } from '@/hooks/useImageContent';
import { useTheme } from '@/hooks/useThemeColor';
import { Image } from 'expo-image';
import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

interface FileViewerProps {
    sandboxId: string;
    filePath: string;
}

export const FileViewer: React.FC<FileViewerProps> = ({
    sandboxId,
    filePath
}) => {
    const theme = useTheme();

    // Use different hooks based on file type
    const isImage = isImageFile(filePath);
    const isText = isTextFile(filePath);

    // For images, use the existing useImageContent hook
    const {
        data: imageData,
        isLoading: isImageLoading,
        error: imageError
    } = useImageContent(sandboxId, filePath);

    // For text files, use the file content hook
    const {
        data: textContent,
        isLoading: isTextLoading,
        error: textError
    } = useFileContent(sandboxId, isText ? filePath : null);

    const isLoading = isImage ? isImageLoading : isTextLoading;
    const error = isImage ? imageError : textError;

    if (isLoading) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: theme.background }]}>
                <ActivityIndicator size="large" color={theme.primary} />
                <Body style={[styles.loadingText, { color: theme.mutedForeground }]}>
                    Loading file...
                </Body>
            </View>
        );
    }

    if (error) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: theme.background }]}>
                <Body style={[styles.errorText, { color: theme.destructive }]}>
                    Failed to load file: {error.message}
                </Body>
            </View>
        );
    }

    const renderContent = () => {
        if (isImage) {
            // Handle image content using existing system
            if (imageData) {
                return (
                    <View style={styles.imageContainer}>
                        <Image
                            source={{ uri: imageData }}
                            style={styles.image}
                            contentFit="contain"
                        />
                    </View>
                );
            }
        }

        if (isText) {
            // Handle text content
            if (typeof textContent === 'string') {
                return (
                    <ScrollView
                        style={[styles.textContainer, { backgroundColor: theme.card }]}
                        contentContainerStyle={styles.textContent}
                    >
                        <Body
                            style={[
                                styles.textBody,
                                {
                                    color: theme.foreground,
                                    fontFamily: 'monospace' // Use monospace for code files
                                }
                            ]}
                        >
                            {textContent}
                        </Body>
                    </ScrollView>
                );
            }
        }

        // Fallback for other file types
        return (
            <View style={[styles.centerContainer, { backgroundColor: theme.background }]}>
                <Body style={[styles.unsupportedText, { color: theme.mutedForeground }]}>
                    Preview not available for this file type
                </Body>
                <Body style={[styles.fileInfoText, { color: theme.mutedForeground }]}>
                    {filePath.split('/').pop()}
                </Body>
            </View>
        );
    };

    return (
        <View style={[styles.container, { backgroundColor: theme.background }]}>
            {renderContent()}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    loadingText: {
        marginTop: 12,
        fontSize: 14,
    },
    errorText: {
        fontSize: 14,
        textAlign: 'center',
    },
    unsupportedText: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 8,
    },
    fileInfoText: {
        fontSize: 12,
        textAlign: 'center',
    },
    imageContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
    },
    image: {
        width: '100%',
        height: '100%',
        maxHeight: 400,
    },
    textContainer: {
        flex: 1,
        margin: 8,
        borderRadius: 8,
    },
    textContent: {
        padding: 16,
    },
    textBody: {
        fontSize: 12,
        lineHeight: 16,
    },
}); 