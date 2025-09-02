'use client';

import { useState } from 'react';
import { Highlighter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useEditorStore } from '@/lib/stores/use-editor-store';

const highlightColors = [
  { name: 'None', value: '' },
  { name: 'Yellow', value: '#fef3c7' },
  { name: 'Green', value: '#d1fae5' },
  { name: 'Blue', value: '#dbeafe' },
  { name: 'Purple', value: '#e9d5ff' },
  { name: 'Pink', value: '#fce7f3' },
  { name: 'Red', value: '#fee2e2' },
  { name: 'Orange', value: '#fed7aa' },
  { name: 'Gray', value: '#e5e7eb' },
  { name: 'Cyan', value: '#cffafe' },
  { name: 'Lime', value: '#d9f99d' },
  { name: 'Indigo', value: '#c7d2fe' },
];

export function HighlightPicker() {
  const { editor } = useEditorStore();
  const [open, setOpen] = useState(false);

  if (!editor) return null;

  const currentHighlight = editor.getAttributes('highlight').color || '';
  const isActive = editor.isActive('highlight');

  const setHighlight = (color: string) => {
    if (color === '') {
      editor.chain().focus().unsetHighlight().run();
    } else {
      editor.chain().focus().toggleHighlight({ color }).run();
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={cn(
            'h-7 w-7 p-0 rounded-sm relative transition-colors hover:bg-muted hover:text-foreground',
            isActive && 'bg-muted text-foreground'
          )}
        >
          <Highlighter className="h-3.5 w-3.5" />
          {currentHighlight && (
            <div 
              className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 rounded-full"
              style={{ backgroundColor: currentHighlight }}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="space-y-3">
          <div className="text-sm font-medium">Highlight Color</div>
          
          <div className="grid grid-cols-4 gap-2">
            {highlightColors.map((color) => (
              <button
                key={color.value}
                onClick={() => setHighlight(color.value)}
                className={cn(
                  'relative h-8 rounded-sm border transition-all hover:scale-105',
                  color.value === '' ? 'border-gray-300 dark:border-gray-600' : 'border-gray-200 dark:border-gray-700',
                  currentHighlight === color.value && 'ring-2 ring-offset-1 ring-blue-500'
                )}
                style={{ 
                  backgroundColor: color.value || 'transparent',
                }}
                aria-label={`Set highlight to ${color.name}`}
              >
                {color.value === '' && (
                  <span className="text-xs text-muted-foreground">None</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-2 border-t">
            <input
              type="color"
              value={currentHighlight || '#fef3c7'}
              onChange={(e) => setHighlight(e.target.value)}
              className="h-8 w-full cursor-pointer rounded"
              aria-label="Custom highlight color"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setHighlight('')}
              className="whitespace-nowrap"
            >
              Clear
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
