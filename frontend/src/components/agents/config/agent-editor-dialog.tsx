'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Wand2, Loader2 } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { AgentAvatar } from '../../thread/content/agent-avatar';
import { IconPicker } from './icon-picker';
import { useGenerateAgentIcon } from '@/hooks/agents/use-agent-icon-generation';

interface AgentEditorDialogProps {
    isOpen: boolean;
    onClose: () => void;
    agentName?: string;
    currentIconName?: string;
    currentIconColor?: string;
    currentBackgroundColor?: string;
    onSave?: (data: {
        name: string;
        iconName: string | null;
        iconColor: string;
        backgroundColor: string;
    }) => void;
}

// Convert HSL to Hex
function hslToHex(h: number, s: number, l: number): string {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

// Convert Hex to HSL hue
function hexToHue(hex: string): number {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return 0;

    const r = parseInt(result[1], 16) / 255;
    const g = parseInt(result[2], 16) / 255;
    const b = parseInt(result[3], 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
        if (max === r) {
            h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        } else if (max === g) {
            h = ((b - r) / delta + 2) / 6;
        } else {
            h = ((r - g) / delta + 4) / 6;
        }
    }

    return Math.round(h * 360);
}

export function AgentEditorDialog({
    isOpen,
    onClose,
    agentName = '',
    currentIconName,
    currentIconColor = '#000000',
    currentBackgroundColor = '#F3F4F6',
    onSave,
}: AgentEditorDialogProps) {
    const [name, setName] = useState(agentName);
    const [iconName, setIconName] = useState(currentIconName || 'bot');
    const [hue, setHue] = useState(0);

    const generateIconMutation = useGenerateAgentIcon();

    // Initialize hue from current background color
    useEffect(() => {
        if (isOpen) {
            setName(agentName);
            setIconName(currentIconName || 'bot');

            // Extract hue from current background color
            const currentHue = hexToHue(currentBackgroundColor);
            setHue(currentHue);
        }
    }, [isOpen, agentName, currentIconName, currentBackgroundColor]);

    // Memoize color generation to prevent recalculation on every render
    const backgroundColor = useMemo(() => hslToHex(hue, 100, 71), [hue]);
    const iconColor = useMemo(() => hslToHex(hue, 12, 22), [hue]);

    // Optimized slider handler
    const handleHueChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setHue(Number(e.target.value));
    }, []);

    // Memoize icon selection handler
    const handleIconSelect = useCallback((icon: string) => {
        setIconName(icon);
    }, []);

    const handleSave = () => {
        if (!name.trim()) {
            toast.error('Worker name is required');
            return;
        }

        if (onSave) {
            onSave({
                name: name.trim(),
                iconName,
                iconColor,
                backgroundColor,
            });
            onClose();
        }
    };

    const handleAutoGenerate = () => {
        if (!name.trim()) {
            toast.error('Worker name is required for auto-generation');
            return;
        }

        generateIconMutation.mutate(
            {
                name: name.trim(),
                description: '',
            },
            {
                onSuccess: (result) => {
                    setIconName(result.icon_name);

                    // Extract hue from generated background
                    const generatedHue = hexToHue(result.icon_background);
                    setHue(generatedHue);

                    toast.success('Agent icon auto-generated!');
                },
                onError: (error) => {
                    console.error('Auto-generation failed:', error);
                    toast.error('Failed to auto-generate icon');
                },
            }
        );
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col p-0">
                <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
                    <DialogTitle>Edit Worker</DialogTitle>
                </DialogHeader>

                <div className="flex-1 min-h-0 overflow-auto px-6 pb-4">
                    <div className="grid grid-cols-1 lg:grid-cols-[350px_1fr] gap-8">
                        {/* Left Side - Preview & Controls */}
                        <div className="space-y-6">
                            {/* Agent Preview */}
                            <div className="flex flex-col items-center space-y-4 pt-4">
                                {useMemo(() => (
                                    <AgentAvatar
                                        iconName={iconName}
                                        iconColor={iconColor}
                                        backgroundColor={backgroundColor}
                                        agentName={name || 'Worker'}
                                        size={120}
                                        className="border-[1.5px] shadow-md"
                                    />
                                ), [iconName, iconColor, backgroundColor, name])}
                                <Input
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="Worker name"
                                    maxLength={50}
                                    className="text-center font-semibold text-lg h-auto py-2"
                                />
                            </div>

                            {/* Hue Slider */}
                            <div className="space-y-3">
                                <Label className="text-sm font-medium">Tint</Label>
                                <div className="relative h-6 flex items-center">
                                    <div
                                        className="absolute inset-0 rounded-full"
                                        style={{
                                            background: 'linear-gradient(to right, #FF0000 0%, #FFFF00 17%, #00FF00 33%, #00FFFF 50%, #0000FF 67%, #FF00FF 83%, #FF0000 100%)'
                                        }}
                                    />
                                    <input
                                        type="range"
                                        min={0}
                                        max={360}
                                        step={1}
                                        value={hue}
                                        onChange={handleHueChange}
                                        className="relative w-full h-6 bg-transparent appearance-none cursor-pointer z-10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-border [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-border [&::-moz-range-thumb]:shadow-lg [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-none"
                                    />
                                </div>
                            </div>
                        </div>                        {/* Right Side - Icon Picker */}
                        <div className="space-y-3 pt-1">
                            <IconPicker
                                selectedIcon={iconName}
                                onIconSelect={handleIconSelect}
                                iconColor={iconColor}
                                backgroundColor={backgroundColor}
                                className="h-[500px]"
                            />
                        </div>
                    </div>
                </div>

                <DialogFooter className="px-6 py-4 shrink-0 border-t">
                    <div className="flex w-full justify-between">
                        <Button
                            variant="outline"
                            onClick={handleAutoGenerate}
                            disabled={generateIconMutation.isPending || !name.trim()}
                            className="gap-2"
                        >
                            {generateIconMutation.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Wand2 className="h-4 w-4" />
                            )}
                            Auto-generate
                        </Button>
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={onClose}>
                                Cancel
                            </Button>
                            <Button onClick={handleSave} disabled={!name.trim()}>
                                Save Changes
                            </Button>
                        </div>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
