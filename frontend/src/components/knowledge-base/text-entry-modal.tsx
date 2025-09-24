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
import { Textarea } from '@/components/ui/textarea';
import { FileText, Loader2, FolderIcon, Info } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { FileNameValidator } from '@/lib/validation';

interface Folder {
    folder_id: string;
    name: string;
    description?: string;
    entry_count: number;
    created_at: string;
}

interface TextEntryModalProps {
    folders: Folder[];
    onUploadComplete: () => void;
}

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export function TextEntryModal({ folders, onUploadComplete }: TextEntryModalProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [selectedFolder, setSelectedFolder] = useState<string>('');
    const [filename, setFilename] = useState('untitled.txt');
    const [content, setContent] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [filenameError, setFilenameError] = useState<string | null>(null);

    const validateFilename = (name: string) => {
        if (!name.trim()) {
            setFilenameError('Filename is required');
            return false;
        }

        const trimmedName = name.trim();

        // Add .txt extension if no extension is provided
        const finalName = trimmedName.includes('.') ? trimmedName : `${trimmedName}.txt`;

        const validation = FileNameValidator.validateName(finalName, 'file');
        if (!validation.isValid) {
            setFilenameError(FileNameValidator.getFriendlyErrorMessage(finalName, 'file'));
            return false;
        }

        setFilenameError(null);
        return true;
    };

    const generateUniqueFilename = (baseName: string, extension: string = '.txt'): string => {
        // Remove extension from baseName if present
        const nameWithoutExt = baseName.replace(/\.[^/.]+$/, '');
        let counter = 1;
        let filename = `${nameWithoutExt}${extension}`;

        // This is a simple client-side check - the backend will handle actual uniqueness
        // But this gives better UX by suggesting incremental names
        while (counter < 100) { // Prevent infinite loop
            const exists = false; // We'll let backend handle actual collision detection
            if (!exists) break;
            filename = `${nameWithoutExt}${counter}${extension}`;
            counter++;
        }

        return filename;
    };

    const handleFilenameChange = (value: string) => {
        setFilename(value);
        if (value.trim()) {
            validateFilename(value);
        } else {
            setFilenameError(null);
        }
    };

    const handleCreate = async () => {
        if (!selectedFolder) {
            toast.error('Please select a folder');
            return;
        }

        if (!validateFilename(filename)) {
            return;
        }

        if (!content.trim()) {
            toast.error('Please enter some content');
            return;
        }

        setIsCreating(true);

        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            // Add .txt extension if not present
            const finalFilename = filename.includes('.') ? filename.trim() : `${filename.trim()}.txt`;

            // Create a text file blob
            const textBlob = new Blob([content], { type: 'text/plain' });
            const file = new File([textBlob], finalFilename, { type: 'text/plain' });

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
                const result = await response.json();
                toast.success('Text file created successfully');

                if (result.filename_changed) {
                    toast.info(`File was renamed to "${result.final_filename}" to avoid conflicts`);
                }

                onUploadComplete();
                setIsOpen(false);
                setFilename('');
                setContent('');
                setSelectedFolder('');
                setFilenameError(null);
            } else {
                const errorData = await response.json().catch(() => null);
                toast.error(errorData?.detail || 'Failed to create text file');
            }
        } catch (error) {
            console.error('Error creating text file:', error);
            toast.error('Failed to create text file');
        } finally {
            setIsCreating(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                <Button variant="outline">
                    <FileText className="h-4 w-4 mr-2" />
                    New Entry
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader className="pb-4">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                            <FileText className="h-5 w-5 text-foreground" />
                        </div>
                        <div>
                            <DialogTitle className="text-xl font-semibold">Create Text Entry</DialogTitle>
                            <p className="text-sm text-muted-foreground mt-1">
                                Write and save text content directly to your knowledge base
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
                                <h4 className="text-sm font-medium mb-2">Create Text Entry</h4>
                                <ul className="text-xs text-muted-foreground space-y-1">
                                    <li>• Write content directly without uploading files</li>
                                    <li>• Automatically saved as .txt format</li>
                                    <li>• Can be searched and referenced by AI agents</li>
                                    <li>• Supports any file extension if specified</li>
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

                    {/* Filename Input */}
                    <div className="space-y-3">
                        <Label htmlFor="filename" className="text-sm font-medium flex items-center gap-2">
                            <FileText className="h-4 w-4" />
                            Filename
                        </Label>
                        <Input
                            id="filename"
                            placeholder="Enter filename (e.g., notes or notes.txt)"
                            value={filename}
                            onChange={(e) => handleFilenameChange(e.target.value)}
                            className={`h-11 ${filenameError ? 'border-red-500' : ''}`}
                        />
                        {filenameError && (
                            <p className="text-sm text-red-600">{filenameError}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                            Will default to .txt extension if none specified
                        </p>
                    </div>

                    {/* Content Input */}
                    <div className="space-y-3">
                        <Label htmlFor="content" className="text-sm font-medium flex items-center gap-2">
                            <FileText className="h-4 w-4" />
                            Content
                        </Label>
                        <Textarea
                            id="content"
                            placeholder="Enter your text content..."
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            rows={12}
                            className="resize-none h-48"
                        />
                        <p className="text-xs text-muted-foreground">
                            Write your content here - it will be saved as a text file in your knowledge base
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 pt-4">
                        <Button
                            variant="outline"
                            onClick={() => setIsOpen(false)}
                            disabled={isCreating}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleCreate}
                            disabled={isCreating || !selectedFolder || !filename.trim() || !content.trim()}
                        >
                            {isCreating ? (
                                <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    Creating...
                                </>
                            ) : (
                                'Create Entry'
                            )}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}