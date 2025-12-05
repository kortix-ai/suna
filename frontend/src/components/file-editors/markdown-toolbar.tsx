'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Link as LinkIcon,
  Image as ImageIcon,
  Table as TableIcon,
  Undo,
  Redo,
  ChevronDown,
  Minus,
  ListTodo,
  Check,
  Loader2,
  AlertCircle,
  Save,
  Type,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Editor } from '@tiptap/react';

interface MarkdownToolbarProps {
  editor: Editor;
  saveState?: 'idle' | 'saving' | 'saved' | 'error';
  onSave?: () => void;
}

export function MarkdownToolbar({ editor, saveState = 'idle', onSave }: MarkdownToolbarProps) {
  const ToolbarButton = ({
    onClick,
    isActive = false,
    disabled = false,
    icon: Icon,
    tooltip,
    shortcut,
  }: {
    onClick: () => void;
    isActive?: boolean;
    disabled?: boolean;
    icon: React.ElementType;
    tooltip: string;
    shortcut?: string;
  }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          onClick={onClick}
          disabled={disabled}
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 w-8 p-0',
            isActive && 'bg-accent text-accent-foreground'
          )}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        <span>{tooltip}</span>
        {shortcut && (
          <kbd className="px-1.5 py-0.5 text-[10px] bg-muted rounded font-mono">
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );

  const insertLink = useCallback(() => {
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('Enter URL:', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const insertImage = useCallback(() => {
    const url = window.prompt('Enter image URL:');
    if (url) {
      editor.chain().focus().setImage({ src: url }).run();
    }
  }, [editor]);

  const insertTable = useCallback(() => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }, [editor]);

  const getCurrentHeadingLabel = () => {
    if (editor.isActive('heading', { level: 1 })) return 'Heading 1';
    if (editor.isActive('heading', { level: 2 })) return 'Heading 2';
    if (editor.isActive('heading', { level: 3 })) return 'Heading 3';
    return 'Normal';
  };

  const SaveButton = () => {
    if (!onSave) return null;

    switch (saveState) {
      case 'saving':
        return (
          <Button variant="secondary" size="sm" disabled className="gap-1.5 h-8 px-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-xs">Saving</span>
          </Button>
        );
      case 'saved':
        return (
          <Button variant="secondary" size="sm" disabled className="gap-1.5 h-8 px-3 text-green-600">
            <Check className="h-3.5 w-3.5" />
            <span className="text-xs">Saved</span>
          </Button>
        );
      case 'error':
        return (
          <Button variant="destructive" size="sm" onClick={onSave} className="gap-1.5 h-8 px-3">
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="text-xs">Retry</span>
          </Button>
        );
      default:
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="default" size="sm" onClick={onSave} className="gap-1.5 h-8 px-3">
                <Save className="h-3.5 w-3.5" />
                <span className="text-xs">Save</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Save changes <kbd className="ml-1.5 px-1 py-0.5 text-[10px] bg-muted rounded font-mono">⌘S</kbd>
            </TooltipContent>
          </Tooltip>
        );
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-b bg-background sticky top-0 z-10">
        <div className="px-2 py-1.5 flex items-center gap-1 flex-wrap">
          {/* Undo/Redo */}
          <div className="flex items-center">
            <ToolbarButton
              onClick={() => editor.chain().focus().undo().run()}
              disabled={!editor.can().undo()}
              icon={Undo}
              tooltip="Undo"
              shortcut="⌘Z"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().redo().run()}
              disabled={!editor.can().redo()}
              icon={Redo}
              tooltip="Redo"
              shortcut="⌘⇧Z"
            />
          </div>

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* Text Style */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 h-8 px-2 min-w-[90px] justify-between">
                <span className="text-xs">{getCurrentHeadingLabel()}</span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                <Type className="mr-2 h-4 w-4" />
                Normal
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
                <Heading1 className="mr-2 h-4 w-4" />
                Heading 1
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                <Heading2 className="mr-2 h-4 w-4" />
                Heading 2
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
                <Heading3 className="mr-2 h-4 w-4" />
                Heading 3
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* Text formatting */}
          <div className="flex items-center">
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleBold().run()}
              isActive={editor.isActive('bold')}
              icon={Bold}
              tooltip="Bold"
              shortcut="⌘B"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleItalic().run()}
              isActive={editor.isActive('italic')}
              icon={Italic}
              tooltip="Italic"
              shortcut="⌘I"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              isActive={editor.isActive('underline')}
              icon={UnderlineIcon}
              tooltip="Underline"
              shortcut="⌘U"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleStrike().run()}
              isActive={editor.isActive('strike')}
              icon={Strikethrough}
              tooltip="Strikethrough"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleCode().run()}
              isActive={editor.isActive('code')}
              icon={Code}
              tooltip="Inline Code"
            />
          </div>

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* Lists */}
          <div className="flex items-center">
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              isActive={editor.isActive('bulletList')}
              icon={List}
              tooltip="Bullet List"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              isActive={editor.isActive('orderedList')}
              icon={ListOrdered}
              tooltip="Numbered List"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleTaskList().run()}
              isActive={editor.isActive('taskList')}
              icon={ListTodo}
              tooltip="Task List"
            />
          </div>

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* Blocks */}
          <div className="flex items-center">
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              isActive={editor.isActive('blockquote')}
              icon={Quote}
              tooltip="Quote"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
              isActive={editor.isActive('codeBlock')}
              icon={Code}
              tooltip="Code Block"
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().setHorizontalRule().run()}
              icon={Minus}
              tooltip="Divider"
            />
          </div>

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* Insert */}
          <div className="flex items-center">
            <ToolbarButton
              onClick={insertLink}
              isActive={editor.isActive('link')}
              icon={LinkIcon}
              tooltip="Link"
              shortcut="⌘K"
            />
            <ToolbarButton onClick={insertImage} icon={ImageIcon} tooltip="Image" />
            <ToolbarButton onClick={insertTable} icon={TableIcon} tooltip="Table" />
          </div>

          {/* Save button */}
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:inline text-xs text-muted-foreground">
              {editor.storage.characterCount?.words() || 0} words
            </span>
            <SaveButton />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

