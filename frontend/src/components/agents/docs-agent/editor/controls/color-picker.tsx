'use client';

import { useState } from 'react';
import { Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useEditorStore } from '@/lib/stores/use-editor-store';

const presetColors = [
  '#000000', // Black
  '#ffffff', // White
  '#ef4444', // Red
  '#f97316', // Orange
  '#f59e0b', // Amber
  '#eab308', // Yellow
  '#84cc16', // Lime
  '#22c55e', // Green
  '#10b981', // Emerald
  '#14b8a6', // Teal
  '#06b6d4', // Cyan
  '#0ea5e9', // Sky
  '#3b82f6', // Blue
  '#6366f1', // Indigo
  '#8b5cf6', // Violet
  '#a855f7', // Purple
  '#d946ef', // Fuchsia
  '#ec4899', // Pink
  '#f43f5e', // Rose
  '#6b7280', // Gray
];

export function ColorPicker() {
  const { editor } = useEditorStore();
  const [open, setOpen] = useState(false);

  if (!editor) return null;

  const currentColor = editor.getAttributes('textStyle').color || '#000000';

  const setColor = (color: string) => {
    editor.chain().focus().setColor(color).run();
    setOpen(false);
  };

  const unsetColor = () => {
    editor.chain().focus().unsetColor().run();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 rounded-sm relative transition-colors hover:bg-muted hover:text-foreground"
        >
          <Palette className="h-3.5 w-3.5" />
          <div 
            className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 rounded-full"
            style={{ backgroundColor: currentColor }}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="space-y-3">
          <div className="text-sm font-medium">Text Color</div>
          
          <div className="grid grid-cols-8 gap-1">
            {presetColors.map((color) => (
              <button
                key={color}
                className={cn(
                  'w-7 h-7 rounded-sm border border-gray-200 dark:border-gray-700 hover:scale-110 transition-transform',
                  currentColor === color && 'ring-2 ring-offset-1 ring-blue-500'
                )}
                style={{ backgroundColor: color }}
                onClick={() => setColor(color)}
                aria-label={`Set color to ${color}`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="color"
              value={currentColor}
              onChange={(e) => setColor(e.target.value)}
              className="h-8 w-full cursor-pointer rounded"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={unsetColor}
            >
              Reset
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
} 