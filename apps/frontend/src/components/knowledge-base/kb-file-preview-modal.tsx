'use client';

import React, { useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FileIcon, Edit, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

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
    const [summary, setSummary] = useState(file.summary);
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // Reset state when file changes or modal opens
    React.useEffect(() => {
        if (isOpen) {
            setSummary(file.summary);
            setIsEditing(true); // Auto-start editing when modal opens
        }
    }, [isOpen, file.entry_id, file.summary]);

    const handleSave = async () => {
        if (!summary.trim()) {
            toast.error('Summary cannot be empty');
            return;
        }

        setIsSaving(true);
        try {
            // Call the parent's edit summary handler directly
            onEditSummary(file.entry_id, file.filename, summary);
            onClose();
        } catch (error) {
            console.error('Error saving summary:', error);
            toast.error('Failed to save summary');
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancel = () => {
        setSummary(file.summary); // Reset to original
        onClose();
    };

    const formatFileSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                            <FileIcon className="h-5 w-5" />
                        </div>
                        <div>
                            <DialogTitle>Edit File Summary</DialogTitle>
                            <p className="text-sm text-muted-foreground mt-1">
                                {file.filename} • {formatFileSize(file.file_size)}
                            </p>
                        </div>
                    </div>
                </DialogHeader>

                <div className="flex-1 flex flex-col space-y-4">
                    <div className="flex-1 flex flex-col space-y-2">
                        <Label htmlFor="summary">Summary</Label>
                        <Textarea
                            id="summary"
                            value={summary}
                            onChange={(e) => setSummary(e.target.value)}
                            placeholder="Enter a description of this file's content..."
                            rows={12}
                            className="resize-none flex-1 min-h-[250px] max-h-[250px]"
                        />
                        <p className="text-xs text-muted-foreground">
                            This summary helps AI agents understand and search for relevant content in this file.
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 pt-4 border-t flex-shrink-0">
                        <Button
                            variant="outline"
                            onClick={handleCancel}
                            disabled={isSaving}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleSave}
                            disabled={!summary.trim() || isSaving}
                            className="gap-2"
                        >
                            {isSaving ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                <>
                                    <Edit className="h-4 w-4" />
                                    Save Summary
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}