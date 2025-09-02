'use client';

import { Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useEditorStore } from '@/lib/stores/use-editor-store';

const fonts = [
  { name: 'Default', value: '' },
  { name: 'Arial', value: 'Arial, sans-serif' },
  { name: 'Times New Roman', value: 'Times New Roman, serif' },
  { name: 'Georgia', value: 'Georgia, serif' },
  { name: 'Courier New', value: 'Courier New, monospace' },
  { name: 'Verdana', value: 'Verdana, sans-serif' },
  { name: 'Trebuchet MS', value: 'Trebuchet MS, sans-serif' },
  { name: 'Comic Sans MS', value: 'Comic Sans MS, cursive' },
  { name: 'System UI', value: 'system-ui, -apple-system, sans-serif' },
  { name: 'Monospace', value: 'ui-monospace, monospace' },
];

export function FontSelector() {
  const { editor } = useEditorStore();

  if (!editor) return null;

  const currentFont = editor.getAttributes('textStyle').fontFamily || '';
  const currentFontName = fonts.find(f => f.value === currentFont)?.name || 'Default';

  const setFont = (fontFamily: string) => {
    if (fontFamily === '') {
      editor.chain().focus().unsetFontFamily().run();
    } else {
      editor.chain().focus().setFontFamily(fontFamily).run();
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-1.5 rounded-sm gap-1 transition-colors hover:bg-muted hover:text-foreground"
        >
          <Type className="h-3.5 w-3.5" />
          <span className="text-xs">{currentFontName}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>Font Family</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {fonts.map((font) => (
          <DropdownMenuItem
            key={font.value}
            onClick={() => setFont(font.value)}
            className={cn(
              'cursor-pointer',
              currentFont === font.value && 'bg-muted'
            )}
            style={{ fontFamily: font.value || 'inherit' }}
          >
            {font.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
} 