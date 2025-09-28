'use client';

import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export interface CustomModelFormData {
    id: string;
    label: string;
}

interface CustomModelDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (modelData: CustomModelFormData) => void;
    initialData: CustomModelFormData;
    mode: 'add' | 'edit';
}

export const CustomModelDialog: React.FC<CustomModelDialogProps> = ({
    isOpen,
    onClose,
    onSave,
    initialData,
    mode,
}) => {
    const [formData, setFormData] = React.useState<CustomModelFormData>(initialData);

    // Reset form data when dialog opens with new initialData
    React.useEffect(() => {
        setFormData(initialData);
    }, [initialData, isOpen]);

    const handleSave = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (formData.id.trim()) {
            onSave(formData);
        }
    };

    const handleClose = () => {
        onClose();
    };

    // Handle input changes
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { id, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [id === 'modelId' ? 'id' : 'label']: value
        }));
    };

    return (
        <Dialog
            open={isOpen}
            onOpenChange={(open) => {
                if (!open) {
                    handleClose();
                }
            }}
        >
            <DialogContent
                className="sm:max-w-[430px]"
                onEscapeKeyDown={handleClose}
                onPointerDownOutside={handleClose}
            >
                <DialogHeader>
                    <DialogTitle>{mode === 'add' ? 'Add Custom Model' : 'Edit Custom Model'}</DialogTitle>
                    <DialogDescription>
                        Kortix Suna uses <b>LiteLLM</b> under the hood, which makes it compatible with over 100 models. You can easily choose any <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 underline">OpenRouter model</a> by prefixing it with <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">openrouter/</code> and it should work out of the box. If you want to use other models besides OpenRouter, you might have to modify the <a href="https://github.com/kortix-ai/suna/blob/main/backend/core/services/llm.py" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 underline">llm.py</a>, set the correct environment variables, and rebuild your self-hosted Docker container.
                    </DialogDescription>



                </DialogHeader>
                <div className="flex flex-col gap-4 py-4">
                    <div className="flex flex-col items-start gap-4">
                        <Label htmlFor="modelId" className="text-right">
                            Model ID
                        </Label>
                        <Input
                            id="modelId"
                            placeholder="e.g. openrouter/meta-llama/llama-4-maverick"
                            value={formData.id}
                            onChange={handleChange}
                            className="col-span-3"
                            onClick={(e) => e.stopPropagation()}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleClose();
                    }}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSave}
                        disabled={!formData.id.trim()}
                    >
                        {mode === 'add' ? 'Add Model' : 'Save Changes'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}; 