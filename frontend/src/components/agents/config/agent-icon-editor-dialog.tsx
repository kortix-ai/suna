'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Sparkles, Wand2, Loader2 } from 'lucide-react';
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
import { IconPicker } from './icon-picker';
import { AgentAvatar } from '../../thread/content/agent-avatar';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { HexColorPicker } from 'react-colorful';
import { useGenerateAgentIcon } from '@/hooks/react-query/agents/use-agent-icon-generation';

interface AgentIconEditorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agentName?: string;
  agentDescription?: string;
  currentIconName?: string;
  currentIconColor?: string;
  currentBackgroundColor?: string;
  onIconUpdate?: (iconName: string | null, iconColor: string, backgroundColor: string) => void;
}

export function AgentIconEditorDialog({
  isOpen,
  onClose,
  agentName,
  agentDescription,
  currentIconName,
  currentIconColor = '#000000',
  currentBackgroundColor = '#F3F4F6',
  onIconUpdate,
}: AgentIconEditorDialogProps) {
  const [selectedIcon, setSelectedIcon] = useState(currentIconName || 'bot');
  const [iconColor, setIconColor] = useState(currentIconColor || '#000000');
  const [backgroundColor, setBackgroundColor] = useState(currentBackgroundColor || '#e5e5e5');
  
  // Debug props when dialog opens
  useEffect(() => {
    if (isOpen) {
      console.log('🔧 AgentIconEditorDialog opened with props:', {
        agentName,
        currentIconName,
        currentIconColor,
        currentBackgroundColor,
        onIconUpdate: !!onIconUpdate
      });
    }
  }, [isOpen, agentName, currentIconName, currentIconColor, currentBackgroundColor, onIconUpdate]);
  
  const generateIconMutation = useGenerateAgentIcon();

  useEffect(() => {
    if (isOpen) {
      setSelectedIcon(currentIconName || 'bot');
      setIconColor(currentIconColor || '#000000');
      setBackgroundColor(currentBackgroundColor || '#e5e5e5');
    }
  }, [isOpen, currentIconName, currentIconColor, currentBackgroundColor]);
  
  const handleIconSave = useCallback(() => {
    if (onIconUpdate) {
      onIconUpdate(selectedIcon, iconColor, backgroundColor);
      // Toast will be shown by parent component
      onClose();
    }
  }, [selectedIcon, iconColor, backgroundColor, onIconUpdate, onClose]);

  const handleAutoGenerate = useCallback(() => {
    if (!agentName) {
      toast.error('Agent name is required for auto-generation');
      return;
    }

    generateIconMutation.mutate(
      {
        name: agentName,
        description: agentDescription,
      },
      {
        onSuccess: (result) => {
          setSelectedIcon(result.icon_name);
          setIconColor(result.icon_color);
          setBackgroundColor(result.icon_background);
          toast.success('Agent icon auto-generated!');
        },
        onError: (error) => {
          console.error('Auto-generation failed:', error);
          toast.error('Failed to auto-generate icon. Please try again.');
        },
      }
    );
  }, [agentName, agentDescription, generateIconMutation]);

  const presetColors = [
    '#000000', '#FFFFFF', '#6366F1', '#10B981', '#F59E0B', 
    '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316',
    '#06B6D4', '#84CC16', '#F43F5E', '#A855F7', '#3B82F6'
  ];

  const ColorPickerField = ({ 
    label, 
    color, 
    onChange,
  }: { 
    label: string;
    color: string;
    onChange: (color: string) => void;
  }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [isInteracting, setIsInteracting] = useState(false);

    return (
      <div className="space-y-2">
        <Label className="text-sm font-medium">{label}</Label>
        <div className="flex items-center gap-3">
          <Popover open={isOpen} onOpenChange={(open) => {
            if (!open || !isInteracting) {
              setIsOpen(open);
            }
          }}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="h-10 w-12 rounded-md border cursor-pointer hover:border-primary/50 transition-colors"
                style={{ backgroundColor: color }}
                aria-label={`${label} color`}
              />
            </PopoverTrigger>
            <PopoverContent
              className="w-auto p-3"
              align="start"
              side="bottom"
              sideOffset={5}
              onInteractOutside={(e) => {
                if (isInteracting) {
                  e.preventDefault();
                  return;
                }
                
                const target = e.target as HTMLElement;
                const isColorPickerElement = target.closest('[class*="react-colorful"]') || 
                  target.className.includes('react-colorful') ||
                  target.closest('.react-colorful-container');
                
                if (isColorPickerElement) {
                  e.preventDefault();
                }
              }}
            >
              <div className="space-y-3">
                <div 
                  className="react-colorful-container"
                  onMouseDown={() => setIsInteracting(true)}
                  onMouseUp={() => setIsInteracting(false)}
                  onTouchStart={() => setIsInteracting(true)}
                  onTouchEnd={() => setIsInteracting(false)}
                >
                  <HexColorPicker 
                    color={color} 
                    onChange={(newColor) => {
                      onChange(newColor);
                    }}
                    style={{ width: '200px', height: '150px' }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={color}
                    onChange={(e) => {
                      const hex = e.target.value;
                      if (/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(hex) || hex.startsWith('#')) {
                        onChange(hex.toUpperCase());
                      }
                    }}
                    placeholder="#000000"
                    className="font-mono text-sm flex-1"
                    maxLength={7}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setIsInteracting(false);
                      setIsOpen(false);
                    }}
                  >
                    Done
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Input
            type="text"
            value={color}
            onChange={(e) => {
              const hex = e.target.value;
              if (/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(hex) || hex.startsWith('#')) {
                onChange(hex.toUpperCase());
              }
            }}
            placeholder="#000000"
            className="font-mono text-sm"
            maxLength={7}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Presets</Label>
          <div className="grid grid-cols-8 gap-1">
            {presetColors.map((presetColor) => (
              <button
                key={presetColor}
                onClick={() => onChange(presetColor)}
                className={cn(
                  "w-7 h-7 rounded border-2 transition-all hover:scale-110",
                  color === presetColor ? "border-primary ring-2 ring-primary/20" : "border-transparent"
                )}
                style={{ backgroundColor: presetColor }}
                title={presetColor}
              />
            ))}
          </div>
        </div>
      </div>
    );
  };

  const presetThemes = [
    { bg: '#6366F1', icon: '#FFFFFF', name: 'Indigo' },
    { bg: '#10B981', icon: '#FFFFFF', name: 'Emerald' },
    { bg: '#F59E0B', icon: '#1F2937', name: 'Amber' },
    { bg: '#EF4444', icon: '#FFFFFF', name: 'Red' },
    { bg: '#8B5CF6', icon: '#FFFFFF', name: 'Purple' },
  ];
  
  const ColorControls = () => (
    <div className="space-y-4">
      <div className="flex flex-col items-center space-y-2 py-3">
        <AgentAvatar
          iconName={selectedIcon}
          iconColor={iconColor}
          backgroundColor={backgroundColor}
          agentName={agentName}
          size={100}
          className="border shadow-lg"
        />
        <div className="text-center">
          <p className="font-medium">{agentName || 'Agent'}</p>
        </div>
      </div>

      <div className="space-y-3">
        <ColorPickerField
          label="Icon Color"
          color={iconColor}
          onChange={setIconColor}
        />

        <ColorPickerField
          label="Background Color"
          color={backgroundColor}
          onChange={setBackgroundColor}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Quick Themes</Label>
        <div className="grid grid-cols-5 gap-1.5">
          {presetThemes.map((preset) => (
            <button
              key={preset.name}
              onClick={() => {
                setIconColor(preset.icon);
                setBackgroundColor(preset.bg);
              }}
              className={cn(
                "group relative h-12 w-full rounded-xl border-2 transition-all hover:scale-105",
                backgroundColor === preset.bg && iconColor === preset.icon 
                  ? "border-primary shadow-md" 
                  : "border-border hover:border-primary/60"
              )}
              style={{ backgroundColor: preset.bg }}
              title={preset.name}
            >
              <span className="absolute inset-0 flex items-center justify-center">
                <Sparkles 
                  className="w-4 h-4" 
                  style={{ color: preset.icon }}
                />
              </span>
              <span className="sr-only">{preset.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col p-0">
        <DialogHeader className="px-4 pt-4 pb-3 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
Customize Agent Icon
          </DialogTitle>
        </DialogHeader>
        <div className="hidden md:flex flex-1 min-h-0 px-4">
          <div className="flex gap-4 w-full">
            <div className="flex-1 min-w-0">
              <IconPicker
                selectedIcon={selectedIcon}
                onIconSelect={setSelectedIcon}
                iconColor={iconColor}
                backgroundColor={backgroundColor}
                className="h-full"
              />
            </div>
            <Separator orientation="vertical" className="h-full" />
            <div className="w-72 shrink-0 flex flex-col h-full">
              <div className="flex-1 overflow-y-auto pr-3">
                <ColorControls />
              </div>
            </div>
          </div>
        </div>
        <div className="md:hidden flex-1 min-h-0 px-4">
          <Tabs defaultValue="customize" className="h-full flex flex-col">
            <TabsList className="grid w-full grid-cols-2 shrink-0">
              <TabsTrigger value="customize">Customize</TabsTrigger>
              <TabsTrigger value="icons">Icons</TabsTrigger>
            </TabsList>
            
            <TabsContent value="customize" className="flex-1 min-h-0 mt-4">
              <ScrollArea className="h-[400px]">
                <ColorControls />
              </ScrollArea>
            </TabsContent>
            <TabsContent value="icons" className="flex-1 min-h-0 mt-4">
              <IconPicker
                selectedIcon={selectedIcon}
                onIconSelect={setSelectedIcon}
                iconColor={iconColor}
                backgroundColor={backgroundColor}
                className="h-[400px]"
              />
            </TabsContent>
          </Tabs>
        </div>
        <DialogFooter className="px-4 py-3 shrink-0 border-t">
          <div className="flex items-center gap-2 mr-auto">
            <Button
              variant="outline"
              onClick={handleAutoGenerate}
              disabled={generateIconMutation.isPending || !agentName}
              className="gap-2"
            >
              {generateIconMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              Auto-generate
            </Button>
          </div>
          <Button
            variant="outline"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button 
            onClick={handleIconSave}
          >
            Save Icon
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
