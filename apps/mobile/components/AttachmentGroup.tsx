import { useTheme } from '@/hooks/useThemeColor';
import { UploadedFile } from '@/utils/file-upload';
import { X } from 'lucide-react-native';
import React from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { FileAttachment } from './FileAttachment';

interface AttachmentGroupProps {
    attachments: string[] | UploadedFile[];
    sandboxId?: string;
    onFilePress?: (path: string) => void;
    onRemove?: (index: number) => void;
    layout?: 'inline' | 'grid';
    showPreviews?: boolean;
    maxHeight?: number;
}

export const AttachmentGroup: React.FC<AttachmentGroupProps> = ({
    attachments,
    sandboxId,
    onFilePress,
    onRemove,
    layout = 'grid',
    showPreviews = true,
    maxHeight = 200
}) => {
    const theme = useTheme();

    // Create styles inside component to access theme
    const styles = StyleSheet.create({
        inlineContainer: {

        },
        inlineContent: {
            paddingRight: 12,
            paddingVertical: 8,
            gap: 8,
        },
        inlineItem: {
            marginRight: 8,
        },
        fileWrapper: {
            position: 'relative',
            paddingRight: 8,
            marginRight: -8,
        },
        removeButton: {
            position: 'absolute',
            top: -5,
            right: 0,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: theme.sidebar,
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 10,
        },
        removeButtonInner: {
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: theme.foreground,
            justifyContent: 'center',
            alignItems: 'center',
        },
        gridContainer: {
            gap: 8,
            marginTop: 8,
        },
        gridItem: {
            width: '100%',
        },
    });

    if (!attachments || attachments.length === 0) {
        return null;
    }

    const isInline = layout === 'inline';

    if (isInline) {
        return (
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[styles.inlineContainer, { maxHeight }]}
                contentContainerStyle={styles.inlineContent}
            >
                {attachments.map((attachment, index) => {
                    const isUploadedFile = typeof attachment === 'object';
                    const filepath = isUploadedFile ? attachment.path : attachment;

                    return (
                        <View key={index} style={styles.inlineItem}>
                            <View style={styles.fileWrapper}>
                                <FileAttachment
                                    filepath={filepath}
                                    sandboxId={sandboxId}
                                    onPress={onFilePress}
                                    layout="inline"
                                    showPreview={showPreviews}
                                    isUploading={isUploadedFile ? attachment.isUploading : false}
                                    uploadError={isUploadedFile ? attachment.uploadError : undefined}
                                    uploadedBlob={isUploadedFile ? attachment.cachedBlob : undefined}
                                    localUri={isUploadedFile ? attachment.localUri : undefined}
                                />
                                {onRemove && (
                                    <TouchableOpacity
                                        style={styles.removeButton}
                                        onPress={() => onRemove(index)}
                                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                                    >
                                        <View style={styles.removeButtonInner}>
                                            <X size={12} color={theme.background} strokeWidth={3} />
                                        </View>
                                    </TouchableOpacity>
                                )}
                            </View>
                        </View>
                    );
                })}
            </ScrollView>
        );
    }

    // Grid layout
    return (
        <View style={styles.gridContainer}>
            {attachments.map((attachment, index) => {
                const isUploadedFile = typeof attachment === 'object';
                const filepath = isUploadedFile ? attachment.path : attachment;

                return (
                    <View key={index} style={styles.gridItem}>
                        <FileAttachment
                            filepath={filepath}
                            sandboxId={sandboxId}
                            onPress={onFilePress}
                            layout="grid"
                            showPreview={showPreviews}
                            isUploading={isUploadedFile ? attachment.isUploading : false}
                            uploadError={isUploadedFile ? attachment.uploadError : undefined}
                            uploadedBlob={isUploadedFile ? attachment.cachedBlob : undefined}
                            localUri={isUploadedFile ? attachment.localUri : undefined}
                        />
                    </View>
                );
            })}
        </View>
    );
}; 