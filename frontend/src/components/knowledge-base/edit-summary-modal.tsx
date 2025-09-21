'use client';

import React, { useState, useEffect } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';

interface EditSummaryModalProps {
    isOpen: boolean;
    onClose: () => void;
    fileName: string;
    currentSummary: string;
    onSave: (summary: string) => Promise<void>;
}

export function EditSummaryModal({
    isOpen,
    onClose,
    fileName,
    currentSummary,
    onSave,
}: EditSummaryModalProps) {
    const [summary, setSummary] = useState(currentSummary);
    const [isLoading, setIsLoading] = useState(false);

    // Reset summary when modal opens with new content
    useEffect(() => {
        if (isOpen) {
            setSummary(currentSummary);
        }
    }, [isOpen, currentSummary]);

    const handleSave = async () => {
        setIsLoading(true);
        try {
            await onSave(summary);
            onClose();
        } catch (error) {
            // Error handling is done in the parent component
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose();
        }
        // Ctrl/Cmd + Enter to save
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            handleSave();
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Edit Summary</DialogTitle>
                    <p className="text-sm text-muted-foreground">{fileName}</p>
                </DialogHeader>

                <div className="py-4">
                    <Textarea
                        value={summary}
                        onChange={(e) => setSummary(e.target.value)}
                        onKeyDown={handleKeyPress}
                        placeholder="Enter a summary for this file..."
                        className="min-h-[120px] resize-none"
                        autoFocus
                        disabled={isLoading}
                    />
                    <p className="text-xs text-muted-foreground mt-2">
                        Tip: Press Ctrl+Enter (Cmd+Enter on Mac) to save quickly
                    </p>
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={onClose}
                        disabled={isLoading}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSave}
                        disabled={isLoading}
                    >
                        {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}