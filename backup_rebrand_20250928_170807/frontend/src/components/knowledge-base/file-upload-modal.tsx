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
import { Upload, FileIcon, X, CheckCircle, AlertCircle, Loader2, FolderIcon, CloudUpload, Plus, Info } from 'lucide-react';
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
    const [isDragOver, setIsDragOver] = useState(false);

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (files) {
            const fileArray = Array.from(files);
            addFiles(fileArray);
        }
    };

    const addFiles = (newFiles: File[]) => {
        setSelectedFiles(prev => [...prev, ...newFiles]);
        setUploadStatuses(prev => [
            ...prev,
            ...newFiles.map(file => ({
                file,
                status: 'queued' as const,
                progress: 0
            }))
        ]);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            addFiles(files);
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
                    <Button className="gap-2">
                        <CloudUpload className="h-4 w-4" />
                        Upload Files
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader className="pb-4">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                            <CloudUpload className="h-5 w-5 text-foreground" />
                        </div>
                        <div>
                            <DialogTitle className="text-xl font-semibold">Upload Files to Knowledge Base</DialogTitle>
                            <p className="text-sm text-muted-foreground mt-1">
                                Add documents, PDFs, and text files that your AI agents can query and reference
                            </p>
                        </div>
                    </div>
                </DialogHeader>

                <div className="space-y-6">
                    {/* Information Section */}
                    <div className="bg-muted/30 rounded-lg p-4 border border-border/50">
                        <div className="flex items-start gap-3">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted mt-0.5">
                                <Info className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div className="flex-1">
                                <h4 className="text-sm font-medium mb-2">How Knowledge Base Works</h4>
                                <ul className="text-xs text-muted-foreground space-y-1">
                                    <li>• Organize files into folders by topic or purpose</li>
                                    <li>• Agents can search and query content from these files</li>
                                    <li>• Supports PDFs, documents, text files, and more</li>
                                    <li>• Files are processed to enable semantic search capabilities</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    {/* Folder Selection */}
                    <div className="space-y-3">
                        <Label htmlFor="folder-select" className="text-sm font-medium flex items-center gap-2">
                            <FolderIcon className="h-4 w-4" />
                            Destination Folder
                        </Label>
                        <Select value={selectedFolder} onValueChange={setSelectedFolder}>
                            <SelectTrigger className="h-11">
                                <SelectValue placeholder="Choose a folder..." />
                            </SelectTrigger>
                            <SelectContent>
                                {folders.map((folder) => (
                                    <SelectItem key={folder.folder_id} value={folder.folder_id}>
                                        <div className="flex items-center gap-3 py-1">
                                            <FolderIcon className="h-4 w-4 text-muted-foreground" />
                                            <div className="flex-1">
                                                <div className="font-medium">{folder.name}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    {folder.entry_count} files
                                                </div>
                                            </div>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Drag & Drop Area */}
                    <div className="space-y-3">
                        <Label className="text-sm font-medium flex items-center gap-2">
                            <Upload className="h-4 w-4" />
                            Upload Files
                        </Label>
                        <div
                            className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-all duration-200 ${
                                isDragOver 
                                    ? 'border-foreground bg-muted/50' 
                                    : 'border-border hover:border-muted-foreground hover:bg-muted/30'
                            }`}
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onDrop={handleDrop}
                        >
                            <input
                                id="file-input"
                                type="file"
                                multiple
                                onChange={handleFileSelect}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                disabled={isUploading}
                            />
                            <div className="flex flex-col items-center gap-3">
                                <div className={`p-3 rounded-full transition-colors ${
                                    isDragOver ? 'bg-muted' : 'bg-muted/50'
                                }`}>
                                    <CloudUpload className={`h-8 w-8 transition-colors ${
                                        isDragOver ? 'text-foreground' : 'text-muted-foreground'
                                    }`} />
                                </div>
                                <div>
                                    <p className={`font-medium transition-colors ${
                                        isDragOver ? 'text-foreground' : 'text-foreground'
                                    }`}>
                                        {isDragOver ? 'Drop files here' : 'Drag & drop files here'}
                                    </p>
                                    <p className="text-sm text-muted-foreground mt-1">
                                        or <span className="text-foreground font-medium">browse files</span> to upload
                                    </p>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Supports PDF, DOC, TXT, MD, CSV, and more • Max 50MB total
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Selected Files List with Upload Progress */}
                    {selectedFiles.length > 0 && (
                        <div className="space-y-3">
                            <Label className="text-sm font-medium flex items-center gap-2">
                                <FileIcon className="h-4 w-4" />
                                Selected Files ({selectedFiles.length})
                            </Label>
                            <div className="border rounded-lg p-4 max-h-48 overflow-y-auto space-y-3 bg-muted/20">
                                {uploadStatuses.map((status, index) => (
                                    <div key={index} className="space-y-2">
                                        <div className="flex items-center gap-3 p-3 bg-background rounded-lg border">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                                                <FileIcon className="h-5 w-5 text-foreground" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between">
                                                    <p className="text-sm font-medium truncate">{status.file.name}</p>
                                                    <div className="flex items-center gap-2 ml-2">
                                                        {status.status === 'uploading' && (
                                                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                                        )}
                                                        {status.status === 'success' && (
                                                            <CheckCircle className="h-4 w-4 text-foreground" />
                                                        )}
                                                        {status.status === 'error' && (
                                                            <AlertCircle className="h-4 w-4 text-foreground" />
                                                        )}
                                                        {status.status === 'queued' && !isUploading && (
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                onClick={() => removeFile(index)}
                                                                className="h-7 w-7 p-0 hover:bg-destructive hover:text-destructive-foreground"
                                                            >
                                                                <X className="h-4 w-4" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="flex items-center justify-between mt-1">
                                                    <span className="text-xs text-muted-foreground">
                                                        {formatFileSize(status.file.size)}
                                                    </span>
                                                    <span className={`text-xs font-medium ${
                                                        status.status === 'success' ? 'text-foreground' :
                                                        status.status === 'error' ? 'text-foreground' :
                                                        status.status === 'uploading' ? 'text-foreground' :
                                                        'text-muted-foreground'
                                                    }`}>
                                                        {status.status === 'success' ? 'Uploaded' :
                                                         status.status === 'error' ? 'Failed' :
                                                         status.status === 'uploading' ? 'Uploading...' :
                                                         'Ready'}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        {/* Error message */}
                                        {status.status === 'error' && status.error && (
                                            <div className="ml-13 bg-muted/30 border border-border rounded-lg p-3">
                                                <p className="text-xs text-muted-foreground">{status.error}</p>
                                            </div>
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