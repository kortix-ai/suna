'use client';

import { useState, useEffect } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { File } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PdfRenderer } from '@/components/thread/preview-renderers/pdf-renderer';
import { HtmlRenderer } from '@/components/thread/preview-renderers/html-renderer';
import { MarkdownRenderer } from '@/components/thread/preview-renderers/file-preview-markdown-renderer';

interface KBFilePreviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    file: {
        entry_id: string;
        filename: string;
        summary: string;
        file_size: number;
        created_at: string;
    };
    onEditSummary: (fileId: string, fileName: string, summary: string) => void;
}

export function KBFilePreviewModal({ isOpen, onClose, file, onEditSummary }: KBFilePreviewModalProps) {
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [binaryBlobUrl, setBinaryBlobUrl] = useState<string | null>(null);

    // File type detection
    const filename = file.filename;
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const isPdf = extension === 'pdf';
    const isMarkdown = ['md', 'markdown'].includes(extension);
    const isHtml = ['html', 'htm'].includes(extension);
    const isCode = ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'css', 'json', 'xml', 'yaml', 'yml'].includes(extension);

    // Renderer mapping like file attachments
    const rendererMap = {
        'html': HtmlRenderer,
        'htm': HtmlRenderer,
        'md': MarkdownRenderer,
        'markdown': MarkdownRenderer,
    };

    // Load file content when modal opens
    useEffect(() => {
        if (isOpen && file.entry_id) {
            loadFileContent();
        } else {
            setFileContent(null);
            if (binaryBlobUrl) {
                URL.revokeObjectURL(binaryBlobUrl);
            }
            setBinaryBlobUrl(null);
        }
    }, [isOpen, file.entry_id]);

    // Cleanup blob URL on unmount
    useEffect(() => {
        return () => {
            if (binaryBlobUrl) {
                URL.revokeObjectURL(binaryBlobUrl);
            }
        };
    }, [binaryBlobUrl]);

    const loadFileContent = async () => {
        setIsLoading(true);
        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';
            console.log('Loading file content for entry_id:', file.entry_id);

            const response = await fetch(`${API_URL}/knowledge-base/entries/${file.entry_id}/download`, {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('Download response status:', response.status);

            if (response.ok) {
                const result = await response.json();
                console.log('Download result:', result);

                if (result.is_binary) {
                    // For binary files (PDFs), create blob URL like file attachments do
                    const binaryString = atob(result.content);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }

                    // Create blob and blob URL like useImageContent does
                    const blob = new Blob([bytes], {
                        type: 'application/pdf'
                    });
                    const blobUrl = URL.createObjectURL(blob);
                    setBinaryBlobUrl(blobUrl);
                    setFileContent(null);
                } else {
                    setFileContent(result.content);
                    setBinaryBlobUrl(null);
                }
            } else {
                const errorText = await response.text();
                console.error('Download failed:', response.status, errorText);
                setFileContent(`Error loading file: ${response.status} ${errorText}`);
            }
        } catch (error) {
            console.error('Failed to load file content:', error);
            setFileContent(`Error loading file: ${error}`);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle>File Preview</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col h-[600px]">
                    {/* File preview - exactly like file browser */}
                    <div className="border rounded-xl overflow-hidden flex flex-col flex-1">
                        <div className="p-2 bg-muted text-sm font-medium border-b">
                            {file.filename}
                        </div>
                        <div className="overflow-y-auto flex-1">
                            {isLoading ? (
                                <div className="space-y-2 p-2">
                                    {[1, 2, 3, 4, 5].map((i) => (
                                        <Skeleton key={i} className="h-4 w-full" />
                                    ))}
                                </div>
                            ) : isPdf && binaryBlobUrl ? (
                                <div className="w-full h-full">
                                    <PdfRenderer url={binaryBlobUrl} className="w-full h-full" />
                                </div>
                            ) : fileContent ? (
                                <div className="p-2 h-full">
                                    {(() => {
                                        // Use appropriate renderer based on file type
                                        const Renderer = rendererMap[extension as keyof typeof rendererMap];

                                        if (Renderer) {
                                            return (
                                                <Renderer
                                                    content={fileContent}
                                                    previewUrl=""
                                                    className="h-full w-full"
                                                />
                                            );
                                        } else if (isCode) {
                                            // For code files, show with syntax highlighting
                                            return (
                                                <pre className="text-xs whitespace-pre-wrap bg-muted/30 p-3 rounded-md overflow-auto h-full">
                                                    <code className={`language-${extension}`}>
                                                        {fileContent}
                                                    </code>
                                                </pre>
                                            );
                                        } else {
                                            // Default text rendering
                                            return (
                                                <pre className="text-xs whitespace-pre-wrap">{fileContent}</pre>
                                            );
                                        }
                                    })()}
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                                    <File className="h-8 w-8 mb-2" />
                                    <p>Select a file to preview</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

            </DialogContent>
        </Dialog>
    );
}