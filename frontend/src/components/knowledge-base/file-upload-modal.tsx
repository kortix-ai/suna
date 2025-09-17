'use client';

import { useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Upload, FileIcon, X, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';

interface Folder {
    folder_id: string;
    name: string;
    description?: string;
    entry_count: number;
    created_at: string;
}

interface FileUploadStatus {
    file: File;
    status: 'queued' | 'uploading' | 'success' | 'error';
    progress: number;
    error?: string;
}

interface FileUploadModalProps {
    folders: Folder[];
    onUploadComplete: () => void;
    trigger?: React.ReactNode;
}

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

export function FileUploadModal({
    folders,
    onUploadComplete,
    trigger
}: FileUploadModalProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [selectedFolder, setSelectedFolder] = useState<string>('');
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatuses, setUploadStatuses] = useState<FileUploadStatus[]>([]);
    const [overallProgress, setOverallProgress] = useState(0);

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (files) {
            const fileArray = Array.from(files);
            setSelectedFiles(fileArray);
            // Initialize upload statuses
            setUploadStatuses(fileArray.map(file => ({
                file,
                status: 'queued',
                progress: 0
            })));
        }
    };

    const removeFile = (index: number) => {
        setSelectedFiles(prev => prev.filter((_, i) => i !== index));
        setUploadStatuses(prev => prev.filter((_, i) => i !== index));
    };

    const handleUpload = async () => {
        if (!selectedFolder) {
            toast.error('Please select a folder');
            return;
        }

        if (selectedFiles.length === 0) {
            toast.error('Please select files to upload');
            return;
        }

        setIsUploading(true);
        setOverallProgress(0);

        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            // Upload files one by one with progress tracking
            let completedFiles = 0;
            const totalFiles = selectedFiles.length;

            for (let i = 0; i < selectedFiles.length; i++) {
                const file = selectedFiles[i];

                // Update file status to uploading
                setUploadStatuses(prev => prev.map((status, index) =>
                    index === i ? { ...status, status: 'uploading', progress: 0 } : status
                ));

                try {
                    const formData = new FormData();
                    formData.append('file', file);

                    const response = await fetch(`${API_URL}/knowledge-base/folders/${selectedFolder}/upload`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${session.access_token}`,
                        },
                        body: formData
                    });

                    if (response.ok) {
                        // Mark file as successful
                        setUploadStatuses(prev => prev.map((status, index) =>
                            index === i ? { ...status, status: 'success', progress: 100 } : status
                        ));
                        completedFiles++;
                    } else {
                        // Handle specific error cases
                        let errorMessage = `Upload failed: ${response.status}`;
                        if (response.status === 413) {
                            try {
                                const errorData = await response.json();
                                errorMessage = errorData.detail || 'Knowledge base limit (50MB) exceeded';
                            } catch {
                                errorMessage = 'Knowledge base limit (50MB) exceeded';
                            }
                        }

                        // Mark file as error
                        setUploadStatuses(prev => prev.map((status, index) =>
                            index === i ? {
                                ...status,
                                status: 'error',
                                progress: 0,
                                error: errorMessage
                            } : status
                        ));
                    }
                } catch (fileError) {
                    // Mark file as error
                    setUploadStatuses(prev => prev.map((status, index) =>
                        index === i ? {
                            ...status,
                            status: 'error',
                            progress: 0,
                            error: `Upload failed: ${fileError}`
                        } : status
                    ));
                }

                // Update overall progress
                setOverallProgress(((i + 1) / totalFiles) * 100);
            }

            if (completedFiles === totalFiles) {
                toast.success(`Successfully uploaded ${completedFiles} file(s)`);
            } else if (completedFiles > 0) {
                toast.success(`Uploaded ${completedFiles} of ${totalFiles} files`);
            } else {
                toast.error('Failed to upload files');
            }

            // Reset form after a short delay to show completion
            setTimeout(() => {
                setSelectedFiles([]);
                setUploadStatuses([]);
                setSelectedFolder('');
                setOverallProgress(0);
                setIsOpen(false);
            }, 2000);

            // Refresh folders
            onUploadComplete();

        } catch (error) {
            console.error('Error uploading files:', error);
            toast.error('Failed to upload files');
        } finally {
            setIsUploading(false);
        }
    };

    const formatFileSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                {trigger || (
                    <Button variant="outline" className="gap-2">
                        <Upload className="h-4 w-4" />
                        Upload Files
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Upload Files to Knowledge Base</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Folder Selection */}
                    <div className="space-y-2">
                        <Label htmlFor="folder-select">Select Folder</Label>
                        <Select value={selectedFolder} onValueChange={setSelectedFolder}>
                            <SelectTrigger>
                                <SelectValue placeholder="Choose a folder..." />
                            </SelectTrigger>
                            <SelectContent>
                                {folders.map((folder) => (
                                    <SelectItem key={folder.folder_id} value={folder.folder_id}>
                                        <div className="flex items-center justify-between w-full">
                                            <span>{folder.name}</span>
                                            <span className="text-xs text-muted-foreground ml-2">
                                                {folder.entry_count} files
                                            </span>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {/* File Selection */}
                    <div className="space-y-2">
                        <Label htmlFor="file-input">Select Files</Label>
                        <div className="relative">
                            <Input
                                id="file-input"
                                type="file"
                                multiple
                                onChange={handleFileSelect}
                                className="file:mr-4 file:py-1 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90"
                            />
                        </div>
                    </div>

                    {/* Selected Files List with Upload Progress */}
                    {selectedFiles.length > 0 && (
                        <div className="space-y-2">
                            <Label>Selected Files</Label>
                            <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-2">
                                {uploadStatuses.map((status, index) => (
                                    <div key={index} className="space-y-1">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2 flex-1 min-w-0">
                                                <FileIcon className="h-4 w-4 flex-shrink-0" />
                                                <span className="text-sm truncate">{status.file.name}</span>
                                                <span className="text-xs text-muted-foreground flex-shrink-0">
                                                    {formatFileSize(status.file.size)}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {status.status === 'uploading' && (
                                                    <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                                                )}
                                                {status.status === 'success' && (
                                                    <CheckCircle className="h-4 w-4 text-green-500" />
                                                )}
                                                {status.status === 'error' && (
                                                    <AlertCircle className="h-4 w-4 text-red-500" />
                                                )}
                                                {status.status === 'queued' && !isUploading && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => removeFile(index)}
                                                        className="h-6 w-6 p-0 hover:bg-destructive hover:text-destructive-foreground"
                                                    >
                                                        <X className="h-3 w-3" />
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                        {/* Error message */}
                                        {status.status === 'error' && status.error && (
                                            <p className="text-xs text-red-500 mt-1">{status.error}</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Upload Button */}
                    <div className="flex justify-end gap-2 pt-2">
                        <Button
                            variant="outline"
                            onClick={() => setIsOpen(false)}
                            disabled={isUploading}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleUpload}
                            disabled={!selectedFolder || selectedFiles.length === 0 || isUploading}
                            className="gap-2"
                        >
                            {isUploading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Uploading...
                                </>
                            ) : (
                                <>
                                    <Upload className="h-4 w-4" />
                                    Upload {selectedFiles.length} file(s)
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}