'use client';

import React, { useState, useRef, useCallback } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogFooter,
    DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Plus,
    CloudUpload,
    FileText,
    GitBranch,
    FolderPlus,
    X,
    CheckCircle,
    AlertCircle,
    Loader2,
    Upload,
    Check,
    FileIcon,
    Folder,
} from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useNameValidation } from '@/lib/validation';
import { cn } from '@/lib/utils';
import { type Folder as FolderType } from '@/hooks/knowledge-base/use-folders';

interface FileUploadStatus {
    file: File;
    status: 'queued' | 'uploading' | 'success' | 'error';
    progress: number;
    error?: string;
}

interface UnifiedKbEntryModalProps {
    folders: FolderType[];
    onUploadComplete: () => void;
    trigger?: React.ReactNode;
    defaultTab?: 'upload' | 'text' | 'git';
}

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export function UnifiedKbEntryModal({
    folders,
    onUploadComplete,
    trigger,
    defaultTab = 'upload'
}: UnifiedKbEntryModalProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [activeTab, setActiveTab] = useState(defaultTab);
    const [selectedFolder, setSelectedFolder] = useState<string>('');

    // Auto-select folder if only one exists
    React.useEffect(() => {
        if (folders.length === 1 && !selectedFolder) {
            setSelectedFolder(folders[0].folder_id);
        }
    }, [folders, selectedFolder]);

    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [isEditingNewFolder, setIsEditingNewFolder] = useState(false);

    // File upload state
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [uploadStatuses, setUploadStatuses] = useState<FileUploadStatus[]>([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const [isUploading, setIsUploading] = useState(false);

    // Text entry state
    const [filename, setFilename] = useState('');
    const [content, setContent] = useState('');
    const [isCreatingText, setIsCreatingText] = useState(false);

    // Git clone state
    const [gitUrl, setGitUrl] = useState('');
    const [gitBranch, setGitBranch] = useState('main');
    const [isCloning, setIsCloning] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const newFolderInputRef = useRef<HTMLInputElement>(null);

    // Validation
    const existingFolderNames = folders.map(f => f.name);
    const folderValidation = useNameValidation(newFolderName, 'folder', existingFolderNames);
    const filenameValidation = useNameValidation(filename, 'file');

    // Check if we have a valid folder (selected or pending valid creation)
    const hasValidFolder = selectedFolder || (isEditingNewFolder && newFolderName.trim() && folderValidation.isValid);

    // Helper: create folder and return its ID
    const createFolder = async (showToast = true): Promise<string | null> => {
        if (!folderValidation.isValid) {
            if (showToast) toast.error(folderValidation.friendlyError || 'Invalid folder name');
            return null;
        }

        setIsCreatingFolder(true);
        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const response = await fetch(`${API_URL}/knowledge-base/folders`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: newFolderName.trim() })
            });

            if (response.ok) {
                const newFolder = await response.json();
                onUploadComplete();
                setSelectedFolder(newFolder.folder_id);
                setNewFolderName('');
                setIsEditingNewFolder(false);
                return newFolder.folder_id;
            } else {
                const errorData = await response.json().catch(() => null);
                if (showToast) toast.error(errorData?.detail || 'Failed to create folder');
                return null;
            }
        } catch (error) {
            console.error('Error creating folder:', error);
            if (showToast) toast.error('Failed to create folder');
            return null;
        } finally {
            setIsCreatingFolder(false);
        }
    };

    // Get existing folder or auto-create pending one
    const getOrCreateFolder = async (): Promise<string | null> => {
        if (selectedFolder) return selectedFolder;

        if (isEditingNewFolder && newFolderName.trim() && folderValidation.isValid) {
            return await createFolder(true);
        }

        toast.error('Please select or create a folder');
        return null;
    };

    const handleFolderCreation = async () => {
        const folderId = await createFolder(true);
        if (folderId) {
            toast.success('Folder created');
        }
    };

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (files) {
            addFiles(Array.from(files));
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

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) addFiles(files);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
    }, []);

    const removeFile = (index: number) => {
        setSelectedFiles(prev => prev.filter((_, i) => i !== index));
        setUploadStatuses(prev => prev.filter((_, i) => i !== index));
    };

    const handleFileUpload = async () => {
        if (selectedFiles.length === 0) {
            toast.error('Please select files to upload');
            return;
        }

        const folderId = await getOrCreateFolder();
        if (!folderId) return;

        setIsUploading(true);

        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            let completedFiles = 0;

            for (let i = 0; i < selectedFiles.length; i++) {
                const file = selectedFiles[i];

                setUploadStatuses(prev => prev.map((status, index) =>
                    index === i ? { ...status, status: 'uploading', progress: 0 } : status
                ));

                try {
                    const formData = new FormData();
                    formData.append('file', file);

                    const response = await fetch(`${API_URL}/knowledge-base/folders/${folderId}/upload`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${session.access_token}` },
                        body: formData
                    });

                    if (response.ok) {
                        setUploadStatuses(prev => prev.map((status, index) =>
                            index === i ? { ...status, status: 'success', progress: 100 } : status
                        ));
                        completedFiles++;
                    } else {
                        let errorMessage = `Upload failed: ${response.status}`;
                        if (response.status === 413) {
                            try {
                                const errorData = await response.json();
                                errorMessage = errorData.detail || 'Knowledge base limit (50MB) exceeded';
                            } catch {
                                errorMessage = 'Knowledge base limit (50MB) exceeded';
                            }
                        }

                        setUploadStatuses(prev => prev.map((status, index) =>
                            index === i ? { ...status, status: 'error', progress: 0, error: errorMessage } : status
                        ));
                    }
                } catch (fileError) {
                    setUploadStatuses(prev => prev.map((status, index) =>
                        index === i ? { ...status, status: 'error', progress: 0, error: `Upload failed: ${fileError}` } : status
                    ));
                }
            }

            if (completedFiles === selectedFiles.length) {
                toast.success(`Uploaded ${completedFiles} file(s)`);
                resetAndClose();
            } else if (completedFiles > 0) {
                toast.success(`Uploaded ${completedFiles} of ${selectedFiles.length} files`);
            } else {
                toast.error('Failed to upload files');
            }

            onUploadComplete();
        } catch (error) {
            console.error('Error uploading files:', error);
            toast.error('Failed to upload files');
        } finally {
            setIsUploading(false);
        }
    };

    const handleTextCreate = async () => {
        if (!filenameValidation.isValid) {
            toast.error(filenameValidation.friendlyError || 'Invalid filename');
            return;
        }

        if (!content.trim()) {
            toast.error('Please enter some content');
            return;
        }

        const folderId = await getOrCreateFolder();
        if (!folderId) return;

        setIsCreatingText(true);

        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const finalFilename = filename.includes('.') ? filename.trim() : `${filename.trim()}.txt`;
            const textBlob = new Blob([content], { type: 'text/plain' });
            const file = new File([textBlob], finalFilename, { type: 'text/plain' });

            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(`${API_URL}/knowledge-base/folders/${folderId}/upload`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${session.access_token}` },
                body: formData
            });

            if (response.ok) {
                const result = await response.json();
                toast.success('Text entry created');
                if (result.filename_changed) {
                    toast.info(`File renamed to "${result.final_filename}"`);
                }
                onUploadComplete();
                resetAndClose();
            } else {
                const errorData = await response.json().catch(() => null);
                toast.error(errorData?.detail || 'Failed to create text entry');
            }
        } catch (error) {
            console.error('Error creating text entry:', error);
            toast.error('Failed to create text entry');
        } finally {
            setIsCreatingText(false);
        }
    };

    const handleGitClone = async () => {
        if (!gitUrl.trim()) {
            toast.error('Please enter a Git repository URL');
            return;
        }

        const folderId = await getOrCreateFolder();
        if (!folderId) return;

        setIsCloning(true);

        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const response = await fetch(`${API_URL}/knowledge-base/folders/${folderId}/clone-git-repo`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    git_url: gitUrl.trim(),
                    branch: gitBranch.trim() || 'main'
                })
            });

            if (response.ok) {
                toast.success('Repository cloning started');
                onUploadComplete();
                resetAndClose();
            } else {
                const errorData = await response.json().catch(() => null);
                toast.error(errorData?.detail || 'Failed to clone repository');
            }
        } catch (error) {
            console.error('Error cloning repository:', error);
            toast.error('Failed to clone repository');
        } finally {
            setIsCloning(false);
        }
    };

    const resetAndClose = () => {
        setTimeout(() => {
            setSelectedFiles([]);
            setUploadStatuses([]);
            setFilename('');
            setContent('');
            setGitUrl('');
            setGitBranch('main');
            setSelectedFolder('');
            setNewFolderName('');
            setIsEditingNewFolder(false);
            setIsOpen(false);
        }, 300);
    };

    const formatFileSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const isLoading = isUploading || isCreatingText || isCloning || isCreatingFolder;

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                {trigger || (
                    <Button className="gap-2">
                        <Plus className="h-4 w-4" />
                        Add Knowledge
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent className="sm:max-w-xl p-0 gap-0 overflow-hidden">
                <DialogHeader className="px-6 pt-6 pb-4">
                    <DialogTitle>Add to Knowledge Base</DialogTitle>
                    <DialogDescription>
                        Upload files, create text entries, or clone repositories
                    </DialogDescription>
                </DialogHeader>

                <div className="px-6 pb-6 space-y-5">
                    {/* Folder Selection */}
                    <div className="space-y-2">
                        <Label>Folder</Label>
                        {isEditingNewFolder ? (
                            <div className="flex gap-2">
                                <Input
                                    ref={newFolderInputRef}
                                    placeholder="New folder name..."
                                    value={newFolderName}
                                    onChange={(e) => setNewFolderName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && folderValidation.isValid) {
                                            handleFolderCreation();
                                        } else if (e.key === 'Escape') {
                                            setIsEditingNewFolder(false);
                                            setNewFolderName('');
                                        }
                                    }}
                                    className={cn(
                                        !folderValidation.isValid && newFolderName && "border-destructive"
                                    )}
                                    disabled={isCreatingFolder}
                                    autoFocus
                                />
                                <Button
                                    size="icon"
                                    onClick={handleFolderCreation}
                                    disabled={!folderValidation.isValid || isCreatingFolder}
                                >
                                    {isCreatingFolder ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Check className="h-4 w-4" />
                                    )}
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => {
                                        setIsEditingNewFolder(false);
                                        setNewFolderName('');
                                    }}
                                    disabled={isCreatingFolder}
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        ) : (
                            <div className="flex gap-2">
                                <Select value={selectedFolder} onValueChange={setSelectedFolder}>
                                    <SelectTrigger className="flex-1">
                                        <SelectValue placeholder={folders.length === 0 ? "No folders" : "Select folder..."} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {folders.map((folder) => (
                                            <SelectItem key={folder.folder_id} value={folder.folder_id}>
                                                <div className="flex items-center gap-2">
                                                    <Folder className="h-4 w-4 text-muted-foreground" />
                                                    <span>{folder.name}</span>
                                                    <span className="text-muted-foreground">({folder.entry_count})</span>
                                                </div>
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Button
                                    size="icon"
                                    variant="outline"
                                    onClick={() => {
                                        setIsEditingNewFolder(true);
                                        setTimeout(() => newFolderInputRef.current?.focus(), 50);
                                    }}
                                >
                                    <FolderPlus className="h-4 w-4" />
                                </Button>
                            </div>
                        )}
                        {!folderValidation.isValid && newFolderName && (
                            <p className="text-sm text-destructive">{folderValidation.friendlyError}</p>
                        )}
                    </div>

                    {/* Tabs */}
                    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
                        <TabsList className="w-full">
                            <TabsTrigger value="upload" className="flex-1 gap-1.5">
                                <CloudUpload className="h-4 w-4" />
                                Upload
                            </TabsTrigger>
                            <TabsTrigger value="text" className="flex-1 gap-1.5">
                                <FileText className="h-4 w-4" />
                                Text
                            </TabsTrigger>
                            <TabsTrigger value="git" className="flex-1 gap-1.5" disabled>
                                <GitBranch className="h-4 w-4" />
                                Git
                                <span className="text-xs text-muted-foreground">(soon)</span>
                            </TabsTrigger>
                        </TabsList>

                        {/* Upload Tab */}
                        <TabsContent value="upload" className="mt-4 space-y-4">
                            <div
                                className={cn(
                                    "relative border-2 border-dashed rounded-2xl p-6 text-center transition-colors cursor-pointer",
                                    isDragOver ? "border-primary bg-accent" : "border-border hover:border-muted-foreground"
                                )}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    multiple
                                    onChange={handleFileSelect}
                                    className="hidden"
                                    disabled={isUploading}
                                />
                                <CloudUpload className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                                <p className="text-sm font-medium">
                                    {isDragOver ? 'Drop files here' : 'Drop files or click to browse'}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    PDF, DOC, TXT, MD, CSV • Max 50MB total
                                </p>
                            </div>

                            {selectedFiles.length > 0 && (
                                <div className="space-y-2 max-h-40 overflow-y-auto">
                                    {uploadStatuses.map((status, index) => (
                                        <div key={index} className="flex items-center gap-3 p-2.5 rounded-xl bg-card border">
                                            <FileIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium truncate">{status.file.name}</p>
                                                <p className="text-xs text-muted-foreground">{formatFileSize(status.file.size)}</p>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                {status.status === 'uploading' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                                                {status.status === 'success' && <CheckCircle className="h-4 w-4 text-green-500" />}
                                                {status.status === 'error' && <AlertCircle className="h-4 w-4 text-destructive" />}
                                                {status.status === 'queued' && !isUploading && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-6 w-6"
                                                        onClick={() => removeFile(index)}
                                                    >
                                                        <X className="h-3 w-3" />
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </TabsContent>

                        {/* Text Tab */}
                        <TabsContent value="text" className="mt-4 space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="filename">Filename</Label>
                                <Input
                                    id="filename"
                                    placeholder="notes.txt"
                                    value={filename}
                                    onChange={(e) => setFilename(e.target.value)}
                                    className={cn(!filenameValidation.isValid && filename && "border-destructive")}
                                />
                                {!filenameValidation.isValid && filename && (
                                    <p className="text-sm text-destructive">{filenameValidation.friendlyError}</p>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="content">Content</Label>
                                <Textarea
                                    id="content"
                                    placeholder="Enter your content..."
                                    value={content}
                                    onChange={(e) => setContent(e.target.value)}
                                    rows={8}
                                    className="resize-none"
                                />
                            </div>
                        </TabsContent>

                        {/* Git Tab */}
                        <TabsContent value="git" className="mt-4 space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="git-url">Repository URL</Label>
                                <Input
                                    id="git-url"
                                    placeholder="https://github.com/user/repo.git"
                                    value={gitUrl}
                                    onChange={(e) => setGitUrl(e.target.value)}
                                    type="url"
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="git-branch">Branch</Label>
                                <Input
                                    id="git-branch"
                                    placeholder="main"
                                    value={gitBranch}
                                    onChange={(e) => setGitBranch(e.target.value)}
                                />
                            </div>
                        </TabsContent>
                    </Tabs>
                </div>

                {/* Footer */}
                <DialogFooter className="px-6 py-4 border-t border-border bg-card/50">
                    <Button variant="ghost" onClick={() => setIsOpen(false)} disabled={isLoading}>
                        Cancel
                    </Button>
                    {activeTab === 'upload' && (
                        <Button
                            onClick={handleFileUpload}
                            disabled={!hasValidFolder || selectedFiles.length === 0 || isLoading}
                        >
                            {isUploading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    Uploading...
                                </>
                            ) : (
                                <>
                                    <Upload className="h-4 w-4 mr-2" />
                                    Upload {selectedFiles.length > 0 && `(${selectedFiles.length})`}
                                </>
                            )}
                        </Button>
                    )}
                    {activeTab === 'text' && (
                        <Button
                            onClick={handleTextCreate}
                            disabled={!hasValidFolder || !filename.trim() || !content.trim() || !filenameValidation.isValid || isLoading}
                        >
                            {isCreatingText ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    Creating...
                                </>
                            ) : (
                                <>
                                    <FileText className="h-4 w-4 mr-2" />
                                    Create
                                </>
                            )}
                        </Button>
                    )}
                    {activeTab === 'git' && (
                        <Button
                            onClick={handleGitClone}
                            disabled={!hasValidFolder || !gitUrl.trim() || isLoading}
                        >
                            {isCloning ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    Cloning...
                                </>
                            ) : (
                                <>
                                    <GitBranch className="h-4 w-4 mr-2" />
                                    Clone
                                </>
                            )}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
