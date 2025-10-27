import { useImageContent } from '@/hooks/useImageContent';
import { useTheme } from '@/hooks/useThemeColor';
import { FileType, getEstimatedFileSize, getFileType } from '@/utils/file-parser';
import { File, FileAudio, FileCode, FileImage, FileText, FileVideo } from 'lucide-react-native';
import React from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getRendererForExtension, hasRenderer } from './file-renderers';

interface FileAttachmentProps {
    filepath: string;
    sandboxId?: string;
    onPress?: (path: string) => void;
    showPreview?: boolean;
    layout?: 'inline' | 'grid';
    isUploading?: boolean;
    uploadError?: string;
    uploadedBlob?: Blob; // For optimistic caching
    localUri?: string; // For React Native local file URIs
}

const getFileIcon = (type: FileType) => {
    const iconProps = { size: 20, strokeWidth: 2 };

    switch (type) {
        case 'image': return <FileImage {...iconProps} />;
        case 'video': return <FileVideo {...iconProps} />;
        case 'audio': return <FileAudio {...iconProps} />;
        case 'code': return <FileCode {...iconProps} />;
        case 'text': return <FileText {...iconProps} />;
        default: return <File {...iconProps} />;
    }
};

const getTypeLabel = (type: FileType, extension?: string): string => {
    if (type === 'code' && extension) {
        return extension.toUpperCase();
    }

    const labels: Record<FileType, string> = {
        image: 'Image',
        video: 'Video',
        audio: 'Audio',
        pdf: 'PDF',
        text: 'Text',
        code: 'Code',
        other: 'File'
    };

    return labels[type];
};

export const FileAttachment: React.FC<FileAttachmentProps> = ({
    filepath,
    sandboxId,
    onPress,
    showPreview = true,
    layout = 'inline',
    isUploading = false,
    uploadError,
    uploadedBlob,
    localUri
}) => {
    const theme = useTheme();
    const filename = filepath.split('/').pop() || 'file';
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const fileType = getFileType(filename);
    const fileSize = getEstimatedFileSize(filepath, fileType);
    const typeLabel = getTypeLabel(fileType, extension);

    const isImage = fileType === 'image';
    const isGrid = layout === 'grid';
    const hasPreviewRenderer = hasRenderer(extension);

    // Debug logging
    console.log(`[FileAttachment] ${filename} - sandboxId: ${sandboxId || 'none'}, localUri: ${localUri ? 'present' : 'none'}, hasRenderer: ${hasPreviewRenderer}`);

    // Use authenticated image loading for images
    const {
        data: imageUrl,
        isLoading: imageLoading,
        error: imageError,
        isProcessing
    } = useImageContent(
        isImage && sandboxId ? sandboxId : undefined,
        isImage ? filepath : undefined,
        uploadedBlob
    );

    // For local files without sandboxId, use localUri directly
    const localImageUri = !sandboxId && isImage && localUri ? localUri : null;

    // Log image state
    const imageSource = localImageUri ? 'LOCAL' : imageUrl ? (imageUrl.startsWith('data:') ? 'CACHED' : 'SERVER') : 'NONE';
    console.log(`[FileAttachment] ${filename} will use: ${imageSource}${imageLoading ? ' (upgrading)' : ''}`);

    const handlePress = () => {
        onPress?.(filepath);
    };

    const containerStyle = [
        styles.container,
        {
            backgroundColor: theme.sidebar,
            borderColor: theme.border,
        },
        isGrid ? styles.gridContainer : styles.inlineContainer
    ];

    // FILE RENDERER PREVIEW LOGIC (HTML, Markdown, etc.)
    if (hasPreviewRenderer && showPreview && isGrid) {
        const RendererComponent = getRendererForExtension(extension);

        if (RendererComponent) {
            console.log(`[FileAttachment] RENDERING WITH ${extension.toUpperCase()} RENDERER - ${filename}`);

            return (
                <View
                    style={{
                        backgroundColor: theme.sidebar,
                        borderColor: theme.border,
                        borderRadius: 12,
                        borderWidth: 1,
                        overflow: 'hidden',
                        width: '100%',
                        aspectRatio: 1.5,
                        maxHeight: 250,
                        minHeight: 150,
                    }}
                >
                    <RendererComponent
                        filepath={filepath}
                        sandboxId={sandboxId}
                        filename={filename}
                        uploadedBlob={uploadedBlob}
                        onExternalOpen={handlePress}
                    />
                </View>
            );
        }
    }

    // IMAGES ALWAYS SHOW AS PREVIEWS
    if (isImage && showPreview) {
        // Dynamic height based on layout with aspect ratio considerations
        const maxHeight = isGrid ? 200 : 54;
        const minHeight = isGrid ? 120 : 54;

        // For local files (no sandboxId), use blob URL directly
        if (!sandboxId && localImageUri) {
            console.log(`[FileAttachment] RENDERING LOCAL IMAGE - ${filename}`);
            console.log(`[FileAttachment] - localImageUri: ${localImageUri}`);
            console.log(`[FileAttachment] - layout: ${isGrid ? 'grid' : 'inline'}`);

            if (isGrid) {
                return (
                    <View
                        style={{
                            backgroundColor: theme.sidebar,
                            borderColor: theme.border,
                            borderRadius: 12,
                            borderWidth: 1,
                            overflow: 'hidden',
                            width: '100%',
                            aspectRatio: 1.5,
                            maxHeight: 250,
                            minHeight: 150,
                        }}
                    >
                        <TouchableOpacity
                            style={styles.imageGridTouchable}
                            onPress={handlePress}
                            activeOpacity={0.8}
                        >
                            <Image
                                source={{ uri: localImageUri }}
                                style={styles.imageGridPreview}
                                resizeMode="cover"
                                onLoad={() => {
                                    console.log(`[FileAttachment] LOCAL IMAGE LOADED (grid) - ${filename}`);
                                }}
                                onError={(error) => {
                                    console.log(`[FileAttachment] LOCAL IMAGE ERROR (grid) - ${filename}:`, error.nativeEvent.error);
                                }}
                            />
                        </TouchableOpacity>
                    </View>
                );
            } else {
                return (
                    <TouchableOpacity
                        style={[
                            styles.container,
                            {
                                backgroundColor: theme.sidebar,
                                borderColor: theme.border,
                            },
                            styles.imageInlineContainer
                        ]}
                        onPress={handlePress}
                        activeOpacity={0.8}
                    >
                        <Image
                            source={{ uri: localImageUri }}
                            style={styles.imageInlinePreview}
                            resizeMode="contain"
                            onLoad={() => {
                                console.log(`[FileAttachment] LOCAL IMAGE LOADED (inline) - ${filename}`);
                            }}
                            onError={(error) => {
                                console.log(`[FileAttachment] LOCAL IMAGE ERROR (inline) - ${filename}:`, error.nativeEvent.error);
                            }}
                        />
                    </TouchableOpacity>
                );
            }
        }

        // Loading state (only for server images AND only if we have no image data at all)
        if (imageLoading && sandboxId && !imageUrl) {
            console.log(`[FileAttachment] RENDERING LOADING STATE - ${filename}`);
            console.log(`[FileAttachment] - sandboxId: ${sandboxId}`);
            console.log(`[FileAttachment] - isProcessing: ${isProcessing}`);
            console.log(`[FileAttachment] - imageUrl: ${imageUrl ? 'present' : 'none'} (no loading if we have cached data)`);

            return (
                <TouchableOpacity
                    style={[
                        containerStyle,
                        {
                            height: minHeight,
                            justifyContent: 'center',
                            alignItems: 'center'
                        }
                    ]}
                    onPress={handlePress}
                    activeOpacity={0.8}
                >
                    <ActivityIndicator size="small" color={theme.mutedForeground} />
                    {isProcessing && (
                        <Text style={[styles.metadataText, { color: theme.mutedForeground, marginTop: 4 }]}>
                            Processing...
                        </Text>
                    )}
                </TouchableOpacity>
            );
        }

        // Error state (but not if processing)
        if (imageError && !isProcessing) {
            console.log(`[FileAttachment] RENDERING ERROR STATE - ${filename}`);
            console.log(`[FileAttachment] - error: ${imageError.message || 'unknown error'}`);
            console.log(`[FileAttachment] - isProcessing: ${isProcessing}`);

            return (
                <TouchableOpacity
                    style={[containerStyle, { height: minHeight }]}
                    onPress={handlePress}
                    activeOpacity={0.8}
                >
                    <View style={[styles.iconContainer, { backgroundColor: theme.background }]}>
                        {React.cloneElement(getFileIcon(fileType), {
                            color: theme.destructive
                        })}
                    </View>
                    <View style={styles.fileInfo}>
                        <Text style={[styles.filename, { color: theme.foreground }]} numberOfLines={1}>
                            {filename}
                        </Text>
                        <Text style={[styles.errorText, { color: theme.destructive }]}>
                            Failed to load
                        </Text>
                    </View>
                </TouchableOpacity>
            );
        }

        // Success: Show image preview with proper aspect ratio (cached or server data)
        if (imageUrl) {
            console.log(`[FileAttachment] HAVE IMAGE DATA - ${filename}`);
            console.log(`[FileAttachment] - imageUrl source: ${imageUrl.startsWith('data:') ? 'CACHED_BLOB' : 'SERVER'}`);
            console.log(`[FileAttachment] - isLoading: ${imageLoading} (upgrading in background)`);
        }

        if (imageUrl && isGrid) {
            console.log(`[FileAttachment] RENDERING SERVER IMAGE (grid) - ${filename}`);
            console.log(`[FileAttachment] - imageUrl: ${imageUrl.substring(0, 50)}`);
            console.log(`[FileAttachment] - sandboxId: ${sandboxId}`);

            return (
                <View
                    style={{
                        backgroundColor: theme.sidebar,
                        borderColor: theme.border,
                        borderRadius: 12,
                        borderWidth: 1,
                        overflow: 'hidden',
                        width: '100%',
                        aspectRatio: 1.5,
                        maxHeight: 250,
                        minHeight: 150,
                    }}
                >
                    <TouchableOpacity
                        style={styles.imageGridTouchable}
                        onPress={handlePress}
                        activeOpacity={0.8}
                    >
                        <Image
                            source={imageUrl ? { uri: imageUrl } : undefined}
                            style={styles.imageGridPreview}
                            resizeMode="cover"
                            onLoad={() => {
                                console.log(`[FileAttachment] SERVER IMAGE LOADED (grid) - ${filename}`);
                                console.log(`[FileAttachment] - imageUrl: ${imageUrl.substring(0, 50)}`);
                            }}
                            onError={(error) => {
                                console.log(`[FileAttachment] SERVER IMAGE ERROR (grid) - ${filename}:`, error.nativeEvent.error);
                                console.log(`[FileAttachment] - imageUrl: ${imageUrl.substring(0, 50)}`);
                                console.log(`[FileAttachment] - sandboxId: ${sandboxId}`);
                            }}
                        />
                    </TouchableOpacity>
                </View>
            );
        } else if (imageUrl) {
            console.log(`[FileAttachment] RENDERING SERVER IMAGE (inline) - ${filename}`);
            console.log(`[FileAttachment] - imageUrl: ${imageUrl.substring(0, 50)}`);
            console.log(`[FileAttachment] - sandboxId: ${sandboxId}`);

            return (
                <TouchableOpacity
                    style={[
                        styles.container,
                        {
                            backgroundColor: theme.sidebar,
                            borderColor: theme.border,
                        },
                        styles.imageInlineContainer
                    ]}
                    onPress={handlePress}
                    activeOpacity={0.8}
                >
                    <Image
                        source={imageUrl ? { uri: imageUrl } : undefined}
                        style={styles.imageInlinePreview}
                        resizeMode="contain"
                        onLoad={() => {
                            console.log(`[FileAttachment] SERVER IMAGE LOADED (inline) - ${filename}`);
                            console.log(`[FileAttachment] - imageUrl: ${imageUrl.substring(0, 50)}`);
                        }}
                        onError={(error) => {
                            console.log(`[FileAttachment] SERVER IMAGE ERROR (inline) - ${filename}:`, error.nativeEvent.error);
                            console.log(`[FileAttachment] - imageUrl: ${imageUrl.substring(0, 50)}`);
                            console.log(`[FileAttachment] - sandboxId: ${sandboxId}`);
                        }}
                    />
                </TouchableOpacity>
            );
        }
    }

    // Regular file display (non-images, non-renderer files)
    return (
        <TouchableOpacity
            style={[containerStyle, { opacity: isUploading ? 0.7 : 1 }]}
            onPress={handlePress}
            activeOpacity={0.8}
        >
            <View style={[styles.iconContainer, { backgroundColor: theme.background }]}>
                {isUploading ? (
                    <ActivityIndicator size="small" color={theme.mutedForeground} />
                ) : (
                    React.cloneElement(getFileIcon(fileType), {
                        color: uploadError ? theme.destructive : theme.mutedForeground
                    })
                )}
            </View>

            <View style={styles.fileInfo}>
                <Text
                    style={[styles.filename, { color: uploadError ? theme.destructive : theme.foreground }]}
                    numberOfLines={1}
                >
                    {filename}
                </Text>
                <View style={styles.metadata}>
                    {uploadError ? (
                        <Text style={[styles.metadataText, { color: theme.destructive }]}>
                            Upload failed
                        </Text>
                    ) : isUploading ? (
                        <Text style={[styles.metadataText, { color: theme.mutedForeground }]}>
                        </Text>
                    ) : (
                        <>
                            <Text style={[styles.metadataText, { color: theme.mutedForeground }]}>
                                {typeLabel}
                            </Text>
                            <Text style={[styles.metadataText, { color: theme.mutedForeground }]}>
                                • {fileSize}
                            </Text>
                        </>
                    )}
                </View>
            </View>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        borderRadius: 12,
        borderWidth: 1,
        overflow: 'hidden',
        flexDirection: 'row',
        alignItems: 'center',
    },
    inlineContainer: {
        height: 54,
        minWidth: 170,
        maxWidth: 300,
        paddingRight: 12,
    },
    gridContainer: {
        width: '100%',
        minWidth: 170,
    },
    imageInlineContainer: {
        height: 54,
        width: 54,
        minWidth: 54,
        maxWidth: 54,
        padding: 0,
        justifyContent: 'center',
        alignItems: 'center',
    },
    iconContainer: {
        width: 54,
        height: 54,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    fileInfo: {
        flex: 1,
        paddingLeft: 12,
        justifyContent: 'center',
        minWidth: 0,
    },
    filename: {
        fontSize: 14,
        fontWeight: '500',
        marginBottom: 2,
    },
    metadata: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    metadataText: {
        fontSize: 12,
        marginRight: 4,
    },
    imageInlinePreview: {
        width: 54,
        height: 54,
    },
    imageGridPreview: {
        width: '100%',
        height: '100%',
    },
    imageOverlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: 8,
    },
    imageFilename: {
        fontSize: 12,
        fontWeight: '500',
    },
    loadingText: {
        fontSize: 12,
        marginTop: 4,
    },
    errorText: {
        fontSize: 12,
    },
    imageGridTouchable: {
        flex: 1,
        width: '100%',
        height: '100%',
        position: 'relative',
    },
}); 