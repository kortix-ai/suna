'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Blockquote from '@tiptap/extension-blockquote';
import CodeBlock from '@tiptap/extension-code-block';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Heading from '@tiptap/extension-heading';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Dropcursor from '@tiptap/extension-dropcursor';
import Gapcursor from '@tiptap/extension-gapcursor';
import Typography from '@tiptap/extension-typography';
import Strike from '@tiptap/extension-strike';
import { Mathematics } from '@tiptap/extension-mathematics';
import 'katex/dist/katex.min.css';

import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { cn } from '@/lib/utils';
import { MarkdownToolbar } from './markdown-toolbar';
import { UnifiedMarkdown } from '@/components/markdown';

// Configure marked for GFM
marked.setOptions({
  gfm: true,
  breaks: true,
});

// Configure turndown for markdown conversion
const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});
turndownService.use(gfm);

// Custom rule for code blocks to preserve language
turndownService.addRule('fencedCodeBlock', {
  filter: (node) => {
    return (
      node.nodeName === 'PRE' &&
      node.firstChild &&
      node.firstChild.nodeName === 'CODE'
    );
  },
  replacement: (content, node) => {
    const codeNode = node.firstChild as HTMLElement;
    const className = codeNode.getAttribute('class') || '';
    const languageMatch = className.match(/language-(\w+)/);
    const language = languageMatch ? languageMatch[1] : '';
    const code = codeNode.textContent || '';
    return `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
  },
});

export interface MarkdownEditorControls {
  getHtml: () => string;
  save: () => void;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  hasChanges: boolean;
}

interface MarkdownEditorProps {
  content: string;
  originalContent?: string; // The saved/persisted content (for tracking unsaved changes across remounts)
  hasUnsavedChanges?: boolean; // Controlled by parent - persists across remounts
  onUnsavedChange?: (hasUnsaved: boolean) => void; // Notify parent when unsaved state changes
  onChange?: (markdown: string) => void;
  onSave?: (markdown: string) => Promise<void>;
  onDiscard?: () => void; // Called when user discards changes
  readOnly?: boolean;
  className?: string;
  placeholder?: string;
  showToolbar?: boolean;
  fileName?: string;
  hideToolbarActions?: boolean; // Hide Export/Save from toolbar (for when they're in header)
  onEditorReady?: (controls: MarkdownEditorControls | null) => void;
  sandboxId?: string; // Sandbox ID for uploading images
}

export function MarkdownEditor({
  content,
  originalContent,
  hasUnsavedChanges: externalHasUnsaved,
  onUnsavedChange,
  onChange,
  onSave,
  onDiscard,
  readOnly = false,
  className,
  placeholder = 'Start writing...',
  showToolbar = true,
  fileName = 'document',
  hideToolbarActions = false,
  onEditorReady,
  sandboxId,
}: MarkdownEditorProps) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [editorInstance, setEditorInstance] = useState<TiptapEditor | null>(null);
  // Use originalContent if provided, otherwise fall back to content (for backwards compatibility)
  const savedContent = useRef<string>(originalContent ?? content);
  const initialHtmlRef = useRef<string | null>(null);
  // Track changes state
  const [hasChanges, setHasChanges] = useState(false);
  const isInitializing = useRef<boolean>(true);
  // Store the "normalized" content after first render (markdown→HTML→markdown)
  const normalizedContent = useRef<string | null>(null);
  
  // Store callback in ref to avoid it being a dependency
  const onUnsavedChangeRef = useRef(onUnsavedChange);
  onUnsavedChangeRef.current = onUnsavedChange;
  
  // Notify parent when hasChanges state changes
  const prevHasChanges = useRef(hasChanges);
  useEffect(() => {
    if (prevHasChanges.current !== hasChanges) {
      prevHasChanges.current = hasChanges;
      onUnsavedChangeRef.current?.(hasChanges);
    }
  }, [hasChanges]);

  // Convert markdown to HTML on initial load
  const initialHtml = useMemo(() => {
    if (initialHtmlRef.current !== null) {
      return initialHtmlRef.current;
    }
    try {
      const html = marked.parse(content || '', { async: false }) as string;
      initialHtmlRef.current = html;
      return html;
    } catch (e) {
      console.error('Failed to parse markdown:', e);
      initialHtmlRef.current = `<p>${content}</p>`;
      return initialHtmlRef.current;
    }
  }, [content]);

  // Convert HTML back to markdown
  const htmlToMarkdown = useCallback((html: string): string => {
    try {
      return turndownService.turndown(html);
    } catch (e) {
      console.error('Failed to convert HTML to markdown:', e);
      return '';
    }
  }, []);

  // Update savedContent ref when originalContent prop changes (e.g., after external save)
  useEffect(() => {
    if (originalContent !== undefined) {
      savedContent.current = originalContent;
    }
  }, [originalContent]);

  // Manual save function
  const handleSave = useCallback(async () => {
    if (!onSave || !editorInstance) return;

    const html = editorInstance.getHTML();
    const markdown = htmlToMarkdown(html);

    if (markdown === savedContent.current) return;

    try {
      setSaveState('saving');
      await onSave(markdown);
      savedContent.current = markdown;
      normalizedContent.current = markdown;
      setHasChanges(false);
      setSaveState('saved');

      setTimeout(() => setSaveState('idle'), 2000);
    } catch (error) {
      console.error('Save error:', error);
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }, [onSave, editorInstance, htmlToMarkdown]);

  // Discard changes function
  const handleDiscard = useCallback(() => {
    if (!editorInstance) return;
    
    const newHtml = marked.parse(savedContent.current || '', { async: false }) as string;
    editorInstance.commands.setContent(newHtml);
    // Update normalized content after discard
    const discardedMarkdown = htmlToMarkdown(newHtml);
    normalizedContent.current = discardedMarkdown;
    setHasChanges(false);
    
    if (onChange) {
      onChange(savedContent.current);
    }
    if (onDiscard) {
      onDiscard();
    }
  }, [editorInstance, onChange, onDiscard, htmlToMarkdown]);

  // TipTap extensions
  const extensions = useMemo(
    () => [
      Document,
      Paragraph.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            class: {
              default: 'text-foreground leading-relaxed my-4 first:mt-0 last:mb-0',
            },
          };
        },
      }),
      Text,
      StarterKit.configure({
        document: false,
        paragraph: false,
        text: false,
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        hardBreak: false,
        strike: false,
      }),
      BulletList.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            class: {
              default: 'my-4 ml-6 list-disc space-y-2 first:mt-0 last:mb-0',
            },
          };
        },
      }),
      OrderedList.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            class: {
              default: 'my-4 ml-6 list-decimal space-y-2 first:mt-0 last:mb-0',
            },
          };
        },
      }),
      ListItem.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            class: {
              default: 'text-foreground leading-relaxed pl-1',
            },
          };
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Blockquote.configure({
        HTMLAttributes: {
          class: 'my-5 pl-4 py-1 border-l-2 border-border text-muted-foreground',
        },
      }),
      CodeBlock.configure({
        HTMLAttributes: {
          class: 'my-5 p-4 rounded-xl overflow-x-auto bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-[13px] font-mono leading-relaxed text-zinc-800 dark:text-zinc-200',
        },
      }),
      HardBreak,
      Heading.configure({ 
        levels: [1, 2, 3, 4, 5, 6],
      }),
      HorizontalRule.configure({
        HTMLAttributes: {
          class: 'my-8 border-0 h-px bg-border/60',
        },
      }),
      Image.configure({
        inline: true,
        allowBase64: true,
        HTMLAttributes: {
          class: 'max-w-full h-auto rounded-xl border border-border/40 shadow-sm my-5',
        },
      }),
      TableKit.configure({
        table: { 
          resizable: true,
          HTMLAttributes: {
            class: 'w-full text-sm my-5 rounded-xl border border-border/60 overflow-hidden',
          },
        },
        tableHeader: {
          HTMLAttributes: {
            class: 'px-4 py-3 text-left text-xs font-semibold text-foreground uppercase tracking-wider bg-muted/50 dark:bg-muted/30',
          },
        },
        tableCell: {
          HTMLAttributes: {
            class: 'px-4 py-3 text-foreground border-t border-border/40',
          },
        },
      }),
      Underline,
      Strike,
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: {
          class: 'font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] decoration-[1px] hover:decoration-foreground/60 transition-colors duration-150',
        },
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right'],
      }),
      Placeholder.configure({
        placeholder,
        showOnlyWhenEditable: true,
      }),
      CharacterCount,
      Dropcursor.configure({ color: 'hsl(var(--primary))', width: 2 }),
      Gapcursor,
      Typography,
      Mathematics,
    ],
    [placeholder]
  );

  const editor = useEditor({
    extensions,
    content: initialHtml,
    editable: !readOnly,
    immediatelyRender: false,
    onCreate({ editor }) {
      setEditorInstance(editor);
      // Store the normalized content (after markdown→HTML→markdown conversion)
      // This is our baseline for detecting actual user changes
      const html = editor.getHTML();
      const markdown = htmlToMarkdown(html);
      normalizedContent.current = markdown;
      isInitializing.current = false;
      // Don't set hasChanges on initial load - only after user edits
      setHasChanges(false);
    },
    onUpdate({ editor, transaction }) {
      setEditorInstance(editor);

      const html = editor.getHTML();
      const markdown = htmlToMarkdown(html);

      // Check if this is a user-initiated change (not programmatic)
      // TipTap transactions from user input don't have the 'preventUpdate' meta
      // Only track changes after initial load
      if (!isInitializing.current && normalizedContent.current !== null) {
        const contentChanged = markdown !== normalizedContent.current;
        setHasChanges(contentChanged);
      }

      if (onChange) {
        onChange(markdown);
      }
    },
      editorProps: {
        attributes: {
          class: cn(
            'focus:outline-none min-h-[200px]',
            // Remove all prose classes - use direct styling like UnifiedMarkdown
          ),
          spellcheck: 'true',
        },
      handleDrop: (view, event, slice, moved) => {
        if (!moved && event.dataTransfer && event.dataTransfer.files.length > 0) {
          const file = event.dataTransfer.files[0];
          if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
              const src = e.target?.result as string;
              const { schema } = view.state;
              const coordinates = view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              });
              if (coordinates) {
                const node = schema.nodes.image.create({ src });
                const transaction = view.state.tr.insert(coordinates.pos, node);
                view.dispatch(transaction);
              }
            };
            reader.readAsDataURL(file);
            return true;
          }
        }
        return false;
      },
    },
  });

  // Update editor content when external content changes (but not if we have unsaved local changes)
  useEffect(() => {
    if (editor && !hasChanges) {
      const newHtml = marked.parse(content || '', { async: false }) as string;
      const currentHtml = editor.getHTML();

      if (newHtml !== currentHtml) {
        editor.commands.setContent(newHtml);
      }
    }
  }, [content, editor, hasChanges]);

  // Update editable state
  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [readOnly, editor]);

  // Manual save handler (Cmd/Ctrl + S)
  useEffect(() => {
    if (!editor || readOnly) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editor, readOnly, handleSave]);

  // Expose editor controls to parent
  useEffect(() => {
    if (onEditorReady) {
      if (editorInstance) {
        onEditorReady({
          getHtml: () => editorInstance.getHTML(),
          save: handleSave,
          saveState,
          hasChanges,
        });
      } else {
        onEditorReady(null);
      }
    }
  }, [editorInstance, handleSave, saveState, hasChanges, onEditorReady]);

  // In read-only mode, use UnifiedMarkdown for consistent rendering
  if (readOnly) {
    return (
      <div className={cn('flex flex-col h-full overflow-hidden bg-background', className)}>
        <div className="flex-1 overflow-auto p-6">
          <UnifiedMarkdown content={content} />
        </div>
      </div>
    );
  }

  // In edit mode, use TipTap editor
  return (
    <div className={cn('flex flex-col h-full overflow-hidden bg-background', className)}>
      {showToolbar && editorInstance && (
        <MarkdownToolbar
          editor={editorInstance}
          saveState={saveState}
          onSave={handleSave}
          onDiscard={handleDiscard}
          fileName={fileName}
          hideActions={hideToolbarActions}
          hasChanges={hasChanges}
          sandboxId={sandboxId}
        />
      )}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto px-6 pb-12 max-w-4xl">
          {editor && (
            <>
              <BubbleMenu
                editor={editor}
                shouldShow={({ editor, view, state, oldState, from, to }) => {
                  // Show when text is selected
                  const { selection } = state;
                  return selection && !selection.empty && selection.from !== selection.to;
                }}
              >
                <div className="flex items-center gap-1 bg-background border border-border rounded-lg shadow-lg p-1">
                  <MarkdownToolbar
                    editor={editor}
                    saveState={saveState}
                    onSave={handleSave}
                    fileName={fileName}
                    hideActions={true}
                    isBubbleMenu={true}
                    sandboxId={sandboxId}
                  />
                </div>
              </BubbleMenu>
              <FloatingMenu
                editor={editor}
                shouldShow={({ editor, view, state, oldState, from, to }) => {
                  // Show when editor is empty
                  const { selection } = state;
                  const { $anchor } = selection;
                  const isRootDepth = $anchor.depth === 1;
                  const isEmpty = editor.state.doc.content.size === 0;
                  return isEmpty && isRootDepth;
                }}
              >
                <div className="flex items-center gap-1 bg-background border border-border rounded-lg shadow-lg p-1">
                  <MarkdownToolbar
                    editor={editor}
                    saveState={saveState}
                    onSave={handleSave}
                    fileName={fileName}
                    hideActions={true}
                    isFloatingMenu={true}
                    sandboxId={sandboxId}
                  />
                </div>
              </FloatingMenu>
            </>
          )}
          <style dangerouslySetInnerHTML={{ __html: `
            /* ═══════════════════════════════════════════════════════════════
               KORTIX TIPTAP EDITOR STYLES
               Matches UnifiedMarkdown for consistent rendering
               ═══════════════════════════════════════════════════════════════ */
            
            /* Headings - Clean hierarchy with proper weight */
            .tiptap-editor h1 {
              font-size: 1.5rem;
              line-height: 2rem;
              font-weight: 600;
              letter-spacing: -0.025em;
              color: hsl(var(--foreground));
              margin-top: 2rem;
              margin-bottom: 1rem;
              padding-bottom: 0.5rem;
              border-bottom: 1px solid hsl(var(--border) / 0.4);
            }
            .tiptap-editor h1:first-child { margin-top: 0; }
            
            .tiptap-editor h2 {
              font-size: 1.25rem;
              line-height: 1.75rem;
              font-weight: 600;
              letter-spacing: -0.025em;
              color: hsl(var(--foreground));
              margin-top: 2rem;
              margin-bottom: 0.75rem;
            }
            .tiptap-editor h2:first-child { margin-top: 0; }
            
            .tiptap-editor h3 {
              font-size: 1.125rem;
              line-height: 1.75rem;
              font-weight: 600;
              color: hsl(var(--foreground));
              margin-top: 1.5rem;
              margin-bottom: 0.5rem;
            }
            .tiptap-editor h3:first-child { margin-top: 0; }
            
            .tiptap-editor h4 {
              font-size: 1rem;
              line-height: 1.5rem;
              font-weight: 600;
              color: hsl(var(--foreground));
              margin-top: 1.25rem;
              margin-bottom: 0.5rem;
            }
            .tiptap-editor h4:first-child { margin-top: 0; }
            
            .tiptap-editor h5 {
              font-size: 0.875rem;
              line-height: 1.25rem;
              font-weight: 600;
              color: hsl(var(--foreground));
              margin-top: 1rem;
              margin-bottom: 0.25rem;
            }
            .tiptap-editor h5:first-child { margin-top: 0; }
            
            .tiptap-editor h6 {
              font-size: 0.875rem;
              line-height: 1.25rem;
              font-weight: 500;
              color: hsl(var(--muted-foreground));
              text-transform: uppercase;
              letter-spacing: 0.05em;
              margin-top: 1rem;
              margin-bottom: 0.25rem;
            }
            .tiptap-editor h6:first-child { margin-top: 0; }
            
            /* Text formatting */
            .tiptap-editor strong {
              font-weight: 600;
              color: hsl(var(--foreground));
            }
            .tiptap-editor em {
              font-style: italic;
              color: hsl(var(--foreground) / 0.9);
            }
            .tiptap-editor del {
              text-decoration: line-through;
              color: hsl(var(--muted-foreground));
              text-decoration-color: hsl(var(--muted-foreground) / 0.5);
            }
            
            /* Inline code - subtle pill style */
            .tiptap-editor code {
              padding: 0.125rem 0.375rem;
              border-radius: 0.375rem;
              font-size: 13px;
              font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
              background-color: hsl(var(--muted));
              color: hsl(var(--foreground));
            }
            
            /* Pre block - code container (light mode default) */
            .tiptap-editor pre {
              background-color: #f4f4f5;
              color: #27272a;
              border-radius: 0.75rem;
              padding: 1rem;
              margin-top: 1.25rem;
              margin-bottom: 1.25rem;
              overflow-x: auto;
              font-size: 13px;
              line-height: 1.625;
              font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
              border: 1px solid #e4e4e7;
            }
            .dark .tiptap-editor pre {
              background-color: #18181b;
              color: #e4e4e7;
              border-color: #27272a;
            }
            .tiptap-editor pre code {
              background-color: transparent;
              color: inherit;
              padding: 0;
              border-radius: 0;
              font-size: inherit;
            }
            
            /* Placeholder styling */
            .tiptap-editor .is-editor-empty:first-child::before {
              color: hsl(var(--muted-foreground) / 0.5);
              content: attr(data-placeholder);
              float: left;
              height: 0;
              pointer-events: none;
            }
            
            /* ═══════════════════════════════════════════════════════════════
               TASK LIST STYLES - Checkbox and text on same line
               ═══════════════════════════════════════════════════════════════ */
            .tiptap-editor ul[data-type="taskList"] {
              list-style: none;
              padding-left: 0;
              margin: 1rem 0;
            }
            .tiptap-editor ul[data-type="taskList"] li {
              display: flex;
              align-items: flex-start;
              gap: 0.5rem;
              margin: 0.25rem 0;
            }
            .tiptap-editor ul[data-type="taskList"] li > label {
              flex-shrink: 0;
              margin-top: 0.125rem;
              user-select: none;
            }
            .tiptap-editor ul[data-type="taskList"] li > label input[type="checkbox"] {
              width: 1rem;
              height: 1rem;
              cursor: pointer;
              accent-color: hsl(var(--primary));
            }
            .tiptap-editor ul[data-type="taskList"] li > div {
              flex: 1;
              min-width: 0;
            }
            .tiptap-editor ul[data-type="taskList"] li > div > p {
              margin: 0;
            }
            /* Nested task lists */
            .tiptap-editor ul[data-type="taskList"] ul[data-type="taskList"] {
              margin: 0.25rem 0 0.25rem 1.5rem;
            }
            
            /* ═══════════════════════════════════════════════════════════════
               TABLE STYLES - Clean, minimal table editing
               ═══════════════════════════════════════════════════════════════ */
            .tiptap-editor table {
              border-collapse: collapse;
              width: 100%;
              margin: 1.5rem 0;
              border-radius: 0.5rem;
              overflow: hidden;
              border: 1px solid hsl(var(--border));
            }
            .tiptap-editor th,
            .tiptap-editor td {
              border: 1px solid hsl(var(--border));
              padding: 0.5rem 0.75rem;
              text-align: left;
              vertical-align: top;
              position: relative;
              min-width: 80px;
            }
            .tiptap-editor th {
              background-color: hsl(var(--muted) / 0.5);
              font-weight: 600;
              font-size: 0.875rem;
            }
            .tiptap-editor td {
              background-color: transparent;
            }
            /* Selected cell highlight */
            .tiptap-editor .selectedCell {
              background-color: hsl(var(--primary) / 0.1) !important;
            }
            .tiptap-editor .selectedCell::after {
              content: "";
              position: absolute;
              inset: 0;
              border: 2px solid hsl(var(--primary));
              pointer-events: none;
            }
            /* Column resize handle */
            .tiptap-editor .column-resize-handle {
              position: absolute;
              right: -2px;
              top: 0;
              bottom: 0;
              width: 4px;
              background-color: hsl(var(--primary));
              cursor: col-resize;
              opacity: 0;
              transition: opacity 0.15s;
            }
            .tiptap-editor th:hover .column-resize-handle,
            .tiptap-editor td:hover .column-resize-handle {
              opacity: 1;
            }
            /* Table wrapper for horizontal scroll */
            .tiptap-editor .tableWrapper {
              overflow-x: auto;
              margin: 1.5rem 0;
            }
          ` }} />
          <div className="tiptap-editor pt-6">
            <EditorContent
              editor={editor}
              className="min-h-[300px]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

