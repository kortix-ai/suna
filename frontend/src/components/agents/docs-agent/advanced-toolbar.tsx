'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Quote, Code,
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  Link as LinkIcon, Image as ImageIcon, Table as TableIcon,
  Undo, Redo, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  ChevronDown, Palette, Highlighter, Type, Plus,
  Superscript, Subscript, RemoveFormatting, Minus,
  IndentIncrease, IndentDecrease, ListTodo, Youtube,
  FileText, Download, Upload, Printer, Search,
  Smile, Hash, Calendar, Clock, Divide, SplitSquareVertical,
  TableProperties, Columns, Rows, Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Editor } from '@tiptap/react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HexColorPicker } from 'react-colorful';

interface AdvancedToolbarProps {
  editor: Editor;
  onExport?: (format: 'pdf' | 'docx' | 'html' | 'markdown' | 'txt') => void;
  wordCount?: number;
  characterCount?: number;
}

export function AdvancedToolbar({ 
  editor, 
  onExport,
  wordCount = 0,
  characterCount = 0 
}: AdvancedToolbarProps) {
  const [textColor, setTextColor] = useState('#000000');
  const [backgroundColor, setBackgroundColor] = useState('#ffffff');
  const [fontSize, setFontSize] = useState(16);
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');

  const ToolbarButton = ({ 
    onClick, 
    isActive = false, 
    disabled = false, 
    icon: Icon, 
    title,
    size = 'default'
  }: {
    onClick: () => void;
    isActive?: boolean;
    disabled?: boolean;
    icon: React.ElementType;
    title: string;
    size?: 'default' | 'sm' | 'lg';
  }) => (
    <Button
      onClick={onClick}
      disabled={disabled}
      variant="ghost"
      size="sm"
      className={cn(
        'h-8 w-8 p-0',
        isActive && 'bg-muted',
        size === 'sm' && 'h-7 w-7',
        size === 'lg' && 'h-9 w-9'
      )}
      title={title}
    >
      <Icon className={cn(
        'h-4 w-4',
        size === 'sm' && 'h-3.5 w-3.5',
        size === 'lg' && 'h-5 w-5'
      )} />
    </Button>
  );

  const fontSizes = [
    { label: 'Small', value: 12 },
    { label: 'Normal', value: 16 },
    { label: 'Large', value: 20 },
    { label: 'Extra Large', value: 24 },
    { label: 'Huge', value: 32 },
  ];

  const fontFamilies = [
    { label: 'Default', value: 'sans-serif' },
    { label: 'Serif', value: 'serif' },
    { label: 'Mono', value: 'monospace' },
    { label: 'Arial', value: 'Arial' },
    { label: 'Times New Roman', value: 'Times New Roman' },
    { label: 'Georgia', value: 'Georgia' },
    { label: 'Courier New', value: 'Courier New' },
    { label: 'Verdana', value: 'Verdana' },
  ];

  const headingLevels = [
    { level: 1, icon: Heading1, label: 'Heading 1' },
    { level: 2, icon: Heading2, label: 'Heading 2' },
    { level: 3, icon: Heading3, label: 'Heading 3' },
    { level: 4, icon: Heading4, label: 'Heading 4' },
    { level: 5, icon: Heading5, label: 'Heading 5' },
    { level: 6, icon: Heading6, label: 'Heading 6' },
  ];

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

  const insertYoutube = useCallback(() => {
    const url = window.prompt('Enter YouTube URL:');
    if (url) {
      editor.commands.setYoutubeVideo({
        src: url,
        width: 640,
        height: 480,
      });
    }
  }, [editor]);

  const insertTable = useCallback(() => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }, [editor]);

  const insertHorizontalRule = useCallback(() => {
    editor.chain().focus().setHorizontalRule().run();
  }, [editor]);

  const insertPageBreak = useCallback(() => {
    editor.chain().focus().setPageBreak().run();
  }, [editor]);

  const addColumnBefore = () => editor.chain().focus().addColumnBefore().run();
  const addColumnAfter = () => editor.chain().focus().addColumnAfter().run();
  const deleteColumn = () => editor.chain().focus().deleteColumn().run();
  const addRowBefore = () => editor.chain().focus().addRowBefore().run();
  const addRowAfter = () => editor.chain().focus().addRowAfter().run();
  const deleteRow = () => editor.chain().focus().deleteRow().run();
  const deleteTable = () => editor.chain().focus().deleteTable().run();
  const mergeCells = () => editor.chain().focus().mergeCells().run();
  const splitCell = () => editor.chain().focus().splitCell().run();
  const toggleHeaderColumn = () => editor.chain().focus().toggleHeaderColumn().run();
  const toggleHeaderRow = () => editor.chain().focus().toggleHeaderRow().run();
  const toggleHeaderCell = () => editor.chain().focus().toggleHeaderCell().run();

  const applyTextColor = (color: string) => {
    setTextColor(color);
    editor.chain().focus().setColor(color).run();
  };

  const applyBackgroundColor = (color: string) => {
    setBackgroundColor(color);
    editor.chain().focus().setHighlight({ color: color }).run();
  };

  const handleFind = () => {
    if (!findText) return;
    const content = editor.getHTML();
    const regex = new RegExp(findText, 'gi');
    const matches = content.match(regex);
    if (matches) {
      alert(`Found ${matches.length} occurrences`);
    }
  };

  const handleReplace = () => {
    if (!findText) return;
    const content = editor.getHTML();
    const newContent = content.replace(new RegExp(findText, 'g'), replaceText);
    editor.commands.setContent(newContent);
  };

  return (
    <div className="border-b -mt-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
      <div className="px-4 py-2 flex items-center gap-1 flex-wrap">
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1">
                <FileText className="h-4 w-4" />
                File
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Download className="mr-2 h-4 w-4" />
                  Export as
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => onExport?.('docx')}>
                    Word Document
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onExport?.('txt')}>
                    Plain Text
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1">
                <Plus className="h-4 w-4" />
                Edit
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => editor.chain().focus().undo().run()}>
                <Undo className="mr-2 h-4 w-4" />
                Undo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => editor.chain().focus().redo().run()}>
                <Redo className="mr-2 h-4 w-4" />
                Redo
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowFindReplace(!showFindReplace)}>
                <Search className="mr-2 h-4 w-4" />
                Find & Replace
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => editor.chain().focus().selectAll().run()}>
                Select All
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu> */}
        </div>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <div className="flex items-center gap-1">
          <ToolbarButton
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!editor.can().undo()}
            icon={Undo}
            title="Undo (Cmd+Z)"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!editor.can().redo()}
            icon={Redo}
            title="Redo (Cmd+Shift+Z)"
          />
        </div>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1 w-32 justify-between">
                <Type className="h-4 w-4" />
                <span className="text-xs">Font</span>
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {fontFamilies.map((font) => (
                <DropdownMenuItem
                  key={font.value}
                  onClick={() => editor.chain().focus().setFontFamily(font.value).run()}
                  style={{ fontFamily: font.value }}
                >
                  {font.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1">
                <span className="text-xs font-medium">{fontSize}px</span>
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {fontSizes.map((size) => (
                <DropdownMenuItem
                  key={size.value}
                  onClick={() => {
                    setFontSize(size.value);
                    editor.chain().focus().setFontSize(`${size.value}px`).run();
                  }}
                >
                  {size.label} ({size.value}px)
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <div className="flex items-center gap-1">
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            isActive={editor.isActive('bold')}
            icon={Bold}
            title="Bold (Cmd+B)"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            isActive={editor.isActive('italic')}
            icon={Italic}
            title="Italic (Cmd+I)"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            isActive={editor.isActive('underline')}
            icon={UnderlineIcon}
            title="Underline (Cmd+U)"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleStrike().run()}
            isActive={editor.isActive('strike')}
            icon={Strikethrough}
            title="Strikethrough"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleSuperscript().run()}
            isActive={editor.isActive('superscript')}
            icon={Superscript}
            title="Superscript"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleSubscript().run()}
            isActive={editor.isActive('subscript')}
            icon={Subscript}
            title="Subscript"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().unsetAllMarks().run()}
            icon={RemoveFormatting}
            title="Clear Formatting"
          />
        </div>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <div className="flex items-center gap-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1">
                <Palette className="h-4 w-4" />
                <div className="w-4 h-1 rounded" style={{ backgroundColor: textColor }} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64">
              <div className="space-y-2">
                <Label>Text Color</Label>
                <HexColorPicker color={textColor} onChange={applyTextColor} />
                <Input
                  value={textColor}
                  onChange={(e) => applyTextColor(e.target.value)}
                  placeholder="#000000"
                />
              </div>
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1">
                <Highlighter className="h-4 w-4" />
                <div className="w-4 h-1 rounded" style={{ backgroundColor }} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64">
              <div className="space-y-2">
                <Label>Highlight Color</Label>
                <HexColorPicker color={backgroundColor} onChange={applyBackgroundColor} />
                <Input
                  value={backgroundColor}
                  onChange={(e) => applyBackgroundColor(e.target.value)}
                  placeholder="#ffffff"
                />
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <div className="flex items-center gap-1">
          <ToolbarButton
            onClick={() => editor.chain().focus().setTextAlign('left').run()}
            isActive={editor.isActive({ textAlign: 'left' })}
            icon={AlignLeft}
            title="Align Left"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().setTextAlign('center').run()}
            isActive={editor.isActive({ textAlign: 'center' })}
            icon={AlignCenter}
            title="Align Center"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().setTextAlign('right').run()}
            isActive={editor.isActive({ textAlign: 'right' })}
            icon={AlignRight}
            title="Align Right"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().setTextAlign('justify').run()}
            isActive={editor.isActive({ textAlign: 'justify' })}
            icon={AlignJustify}
            title="Justify"
          />
        </div>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1">
              <Heading1 className="h-4 w-4" />
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
              Normal Text
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {headingLevels.map(({ level, icon: Icon, label }) => (
              <DropdownMenuItem
                key={level}
                onClick={() => editor.chain().focus().toggleHeading({ level: level as any }).run()}
              >
                <Icon className="mr-2 h-4 w-4" />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <div className="flex items-center gap-1">
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            isActive={editor.isActive('bulletList')}
            icon={List}
            title="Bullet List"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            isActive={editor.isActive('orderedList')}
            icon={ListOrdered}
            title="Numbered List"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleTaskList().run()}
            isActive={editor.isActive('taskList')}
            icon={ListTodo}
            title="Task List"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().sinkListItem('listItem').run()}
            icon={IndentIncrease}
            title="Increase Indent"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().liftListItem('listItem').run()}
            icon={IndentDecrease}
            title="Decrease Indent"
          />
        </div>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <div className="flex items-center gap-1">
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            isActive={editor.isActive('blockquote')}
            icon={Quote}
            title="Quote"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            isActive={editor.isActive('codeBlock')}
            icon={Code}
            title="Code Block"
          />
        </div>
        <Separator orientation="vertical" className="h-6 mx-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1">
              <Plus className="h-4 w-4" />
              Insert
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align='end'>
            <DropdownMenuItem onClick={insertLink}>
              <LinkIcon className="h-4 w-4" />
              Link
            </DropdownMenuItem>
            <DropdownMenuItem onClick={insertImage}>
              <ImageIcon className="h-4 w-4" />
              Image
            </DropdownMenuItem>
            <DropdownMenuItem onClick={insertYoutube}>
              <Youtube className="h-4 w-4" />
              YouTube Video
            </DropdownMenuItem>
            <DropdownMenuItem onClick={insertTable}>
              <TableIcon className="h-4 w-4" />
              Table
            </DropdownMenuItem>
            <DropdownMenuItem onClick={insertHorizontalRule}>
              <Minus className="h-4 w-4" />
              Horizontal Rule
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => editor.chain().focus().insertContent('📅 ' + new Date().toLocaleDateString()).run()}>
              <Calendar className="h-4 w-4" />
              Date
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => editor.chain().focus().insertContent('🕐 ' + new Date().toLocaleTimeString()).run()}>
              <Clock className="h-4 w-4" />
              Time
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {editor.isActive('table') && (
          <>
            <Separator orientation="vertical" className="h-6 mx-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1">
                  <TableIcon className="h-4 w-4" />
                  Table
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56" align='start'>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Columns className="mr-2 h-4 w-4" />
                    Columns
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={addColumnBefore}>
                      Add Column Before
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={addColumnAfter}>
                      Add Column After
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={deleteColumn}>
                      Delete Column
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Rows className="mr-2 h-4 w-4" />
                    Rows
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={addRowBefore}>
                      Add Row Before
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={addRowAfter}>
                      Add Row After
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={deleteRow}>
                      Delete Row
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={mergeCells}>
                  Merge Cells
                </DropdownMenuItem>
                <DropdownMenuItem onClick={splitCell}>
                  Split Cell
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={toggleHeaderRow}>
                  Toggle Header Row
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleHeaderColumn}>
                  Toggle Header Column
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={deleteTable} className="text-destructive">
                  <Trash2 className="h-4 w-4" />
                  Delete Table
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      {showFindReplace && (
        <div className="px-4 py-2 border-t flex items-center gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="find" className="text-xs">Find:</Label>
            <Input
              id="find"
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
              placeholder="Search text..."
              className="h-7 w-40"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="replace" className="text-xs">Replace:</Label>
            <Input
              id="replace"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              placeholder="Replace with..."
              className="h-7 w-40"
            />
          </div>
          <Button size="sm" variant="secondary" onClick={handleFind}>
            Find
          </Button>
          <Button size="sm" variant="secondary" onClick={handleReplace}>
            Replace All
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowFindReplace(false)}
            className="ml-auto"
          >
            Close
          </Button>
        </div>
      )}
    </div>
  );
}
