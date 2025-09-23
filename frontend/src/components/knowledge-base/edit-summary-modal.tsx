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
import { Badge } from '@/components/ui/badge';
import { Loader2, FileText, Sparkles, Save, X, Info } from 'lucide-react';

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
            <DialogContent className="sm:max-w-[600px] gap-0">
                <DialogHeader className="pb-6">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                            <FileText className="h-5 w-5 text-foreground" />
                        </div>
                        <div className="flex-1">
                            <DialogTitle className="flex items-center gap-2 text-lg">
                                Edit Summary
                                <Sparkles className="h-4 w-4 text-muted-foreground" />
                            </DialogTitle>
                            <div className="flex items-center gap-2 mt-1">
                                <Badge variant="secondary" className="text-xs">
                                    {fileName}
                                </Badge>
                            </div>
                        </div>
                    </div>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-foreground">
                            Summary Content
                        </label>
                        <Textarea
                            value={summary}
                            onChange={(e) => setSummary(e.target.value)}
                            onKeyDown={handleKeyPress}
                            placeholder="Describe what this file contains, its purpose, and key information that would help agents understand and work with it..."
                            className="min-h-[140px] resize-none border-border/50 text-sm leading-relaxed"
                            autoFocus
                            disabled={isLoading}
                        />
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Info className="h-3 w-3" />
                                <span>Good summaries help agents understand your files better</span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {summary.length} characters
                            </div>
                        </div>
                    </div>

                    <div className="bg-muted/30 rounded-lg p-4 border border-border/50">
                        <div className="flex items-center gap-2 mb-2">
                            <Info className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">Quick Tips</span>
                        </div>
                        <ul className="text-xs text-muted-foreground space-y-1">
                            <li>• Include the file's main purpose and content</li>
                            <li>• Mention key concepts or data it contains</li>
                            <li>• Note any special formatting or structure</li>
                            <li>• Press <kbd className="px-1 py-0.5 bg-background rounded border">Ctrl+Enter</kbd> to save quickly</li>
                        </ul>
                    </div>
                </div>

                <DialogFooter className="pt-6">
                    <Button
                        variant="outline"
                        onClick={onClose}
                        disabled={isLoading}
                        className="gap-2"
                    >
                        <X className="h-4 w-4" />
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSave}
                        disabled={isLoading || summary.trim().length === 0}
                        className="gap-2"
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            <>
                                <Save className="h-4 w-4" />
                                Save Summary
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}