'use client';

import React, { useState } from 'react';
import { ArrowLeft, Save, Settings, GitBranch, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useRouter } from 'next/navigation';

interface WorkflowHeaderProps {
    workflowName: string;
    workflowDescription?: string;
    onToggleSidePanel: () => void;
    onSave: () => void;
    onExecute?: () => void;
    isSaving?: boolean;
    isExecuting?: boolean;
    onNameChange?: (name: string) => void;
    onDescriptionChange?: (description: string) => void;
}

export function WorkflowHeader({
    workflowName,
    workflowDescription,
    onToggleSidePanel,
    onSave,
    onExecute,
    isSaving = false,
    isExecuting = false,
    onNameChange,
    onDescriptionChange
}: WorkflowHeaderProps) {
    const router = useRouter();
    const [isSettingsPopoverOpen, setIsSettingsPopoverOpen] = useState(false);
    const [localName, setLocalName] = useState(workflowName);
    const [localDescription, setLocalDescription] = useState(workflowDescription || '');

    const handleNameChange = (value: string) => {
        setLocalName(value);
        onNameChange?.(value);
    };

    const handleDescriptionChange = (value: string) => {
        setLocalDescription(value);
        onDescriptionChange?.(value);
    };

    return (
        <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => router.back()}
                    className="h-8 w-8"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Button>

                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
                        <GitBranch className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                        <h1 className="text-lg font-semibold">
                            {workflowName || 'Untitled Workflow'}
                        </h1>
                    </div>

                    <Popover open={isSettingsPopoverOpen} onOpenChange={setIsSettingsPopoverOpen}>
                        <PopoverTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 ml-2">
                                <Settings className="h-4 w-4" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-96" align="start">
                            <div className="space-y-4">
                                <div>
                                    <h3 className="font-medium text-sm mb-3">Workflow Settings</h3>
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium">Name</Label>
                                    <Input
                                        value={localName}
                                        onChange={(e) => handleNameChange(e.target.value)}
                                        placeholder="Enter workflow name"
                                        className="h-8"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium">Description</Label>
                                    <Textarea
                                        value={localDescription}
                                        onChange={(e) => handleDescriptionChange(e.target.value)}
                                        placeholder="Describe what this workflow does"
                                        rows={3}
                                        className="resize-none text-sm"
                                    />
                                </div>
                                <Button
                                    onClick={() => setIsSettingsPopoverOpen(false)}
                                    className="w-full h-8"
                                    size="sm"
                                >
                                    Done
                                </Button>
                            </div>
                        </PopoverContent>
                    </Popover>
                </div>
            </div>

            <div className="flex items-center gap-2">
                {onExecute && (
                    <Button
                        onClick={onExecute}
                        disabled={isExecuting || isSaving}
                        variant="outline"
                        size="sm"
                    >
                        <Play className="h-3.5 w-3.5" />
                        {isExecuting ? 'Executing...' : 'Execute'}
                    </Button>
                )}
                <Button
                    onClick={onSave}
                    disabled={isSaving}
                    size="sm"
                    className="h-8"
                >
                    <Save className="h-3.5 w-3.5" />
                    {isSaving ? 'Saving...' : 'Save Workflow'}
                </Button>
            </div>
        </div>
    );
} 