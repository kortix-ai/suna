"use client"

import { EditorContent, useEditor, type Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Blockquote from '@tiptap/extension-blockquote'
import CodeBlock from '@tiptap/extension-code-block'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Heading from '@tiptap/extension-heading'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import Youtube from '@tiptap/extension-youtube'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { FontFamily } from '@tiptap/extension-font-family'
import Highlight from '@tiptap/extension-highlight'
import Collaboration from '@tiptap/extension-collaboration'
import TextAlign from '@tiptap/extension-text-align'
import Superscript from '@tiptap/extension-superscript'
import Subscript from '@tiptap/extension-subscript'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import Dropcursor from '@tiptap/extension-dropcursor'
import Gapcursor from '@tiptap/extension-gapcursor'
import History from '@tiptap/extension-history'
import Typography from '@tiptap/extension-typography'
import Strike from '@tiptap/extension-strike'
import { Mathematics } from '@tiptap/extension-mathematics'
import 'katex/dist/katex.min.css'

import { useEditorStore } from '@/lib/stores/use-editor-store';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import debounce from 'lodash/debounce';

import { Extension } from '@tiptap/core';
import { Ruler } from "./ruler";

const FontSize = Extension.create({
  name: 'fontSize',

  addOptions() {
    return {
      types: ['textStyle'],
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: element => element.style.fontSize?.replace(/['"]+/g, ''),
            renderHTML: attributes => {
              if (!attributes.fontSize) {
                return {};
              }
              return {
                style: `font-size: ${attributes.fontSize}`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize: (fontSize: string) => ({ chain }) => {
        return chain().setMark('textStyle', { fontSize }).run();
      },
      unsetFontSize: () => ({ chain }) => {
        return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run();
      },
    };
  },
});

interface EditorProps {
  content?: string;
  onChange?: (content: string) => void;
  onEditorReady?: (editor: TiptapEditor) => void;
  onSaveStateChange?: (state: 'saving' | 'saved' | 'unsaved') => void;
  onStatsChange?: (stats: { words: number; characters: number }) => void;
  className?: string;
  editorClassName?: string;
  useStore?: boolean;
  placeholder?: string;
  minHeight?: string;
  readOnly?: boolean;
  documentId?: string;
  autoSave?: boolean;
  autoSaveDelay?: number;
  showWordCount?: boolean;
}

export const Editor = ({
  content = `
    <h1>Welcome to Your Professional Document Editor</h1>
    <p>Start writing your document here. This editor includes:</p>
    <ul>
      <li>Rich text formatting</li>
      <li>Tables and lists</li>
      <li>Images and videos</li>
      <li>Mathematical equations</li>
      <li>And much more!</li>
    </ul>
  `,
  onChange,
  onEditorReady,
  onSaveStateChange,
  onStatsChange,
  className = "size-full overflow-x-auto px-4",
  editorClassName = "focus:outline-none bg-white dark:bg-muted/10 border border flex flex-col min-h-[1054px] w-[816px] pt-10 pr-14 pb-10 cursor-text rounded-md",
  useStore = true,
  placeholder = "Start typing your document...",
  minHeight = "1054px",
  readOnly = false,
  documentId = 'default-doc',
  autoSave = false,
  autoSaveDelay = 2000,
  showWordCount = true,
}: EditorProps) => {
    const { setEditor } = useEditorStore();
    const [isSaving, setIsSaving] = useState(false);
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    const lastSavedContent = useRef(content);
    const pendingUpdates = useRef<NodeJS.Timeout | null>(null);
    
    const ydoc = useMemo(() => autoSave ? new Y.Doc() : null, [autoSave, documentId]);
    const indexeddbProvider = useRef<IndexeddbPersistence | null>(null);
    const [isSynced, setIsSynced] = useState(false);

    useEffect(() => {
      if (!autoSave || !ydoc || !documentId) return;

      const idbProvider = new IndexeddbPersistence(documentId, ydoc);
      indexeddbProvider.current = idbProvider;
      
      idbProvider.on('synced', () => {
        console.log('Content synced with IndexedDB');
        setIsSynced(true);
        if (onSaveStateChange) {
          onSaveStateChange('saved');
        }
      });

      return () => {
        idbProvider.destroy();
        ydoc.destroy();
      };
    }, [autoSave, documentId, ydoc, onSaveStateChange]);

    const saveContent = useMemo(
      () =>
        debounce(async (editor: TiptapEditor) => {
          if (!onChange) return;
          
          const htmlContent = editor.getHTML();
          if (htmlContent === lastSavedContent.current) return;

          try {
            setIsSaving(true);
            if (onSaveStateChange) {
              onSaveStateChange('saving');
            }
            
            await onChange(htmlContent);
            
            lastSavedContent.current = htmlContent;
            setHasUnsavedChanges(false);
            
            if (onSaveStateChange) {
              onSaveStateChange('saved');
            }
          } catch (error) {
            console.error('Error saving document:', error);
            if (onSaveStateChange) {
              onSaveStateChange('unsaved');
            }
          } finally {
            setIsSaving(false);
          }
        }, autoSaveDelay),
      [onChange, autoSaveDelay, onSaveStateChange]
    );

    const extensions = useMemo(() => {
      const baseExtensions = [
        Document,
        Paragraph,
        Text,
        StarterKit,
        BulletList,
        OrderedList,
        ListItem,
        TaskList,
        TaskItem.configure({
          nested: true,
        }),
        Blockquote,
        CodeBlock,
        Details.configure({
          persist: true,
          HTMLAttributes: {
            class: 'details',
          },
        }),
        DetailsSummary,
        DetailsContent,
        HardBreak,
        Heading.configure({
          levels: [1, 2, 3, 4, 5, 6],
        }),
        Highlight.configure({ multicolor: true }),
        HorizontalRule,
        Image.configure({
          inline: true,
          allowBase64: true,
          HTMLAttributes: {
            class: 'w-full h-auto rounded-lg object-contain',
            loading: 'lazy',
            decoding: 'async',
          },
        }),
        Underline,
        Strike,
        Link.configure({
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          HTMLAttributes: {
            class: 'text-blue-500 hover:text-blue-600 underline cursor-pointer',
          },
        }),
        TableKit.configure({
          table: { resizable: true },
        }),
        Youtube.configure({
          controls: true,
          nocookie: true,
        }),
        TextStyle,
        Color,
        FontFamily,
        FontSize,
        Highlight.configure({ 
          multicolor: true,
        }),
        TextAlign.configure({
          types: ['heading', 'paragraph'],
          alignments: ['left', 'center', 'right', 'justify'],
        }),
        Superscript,
        Subscript,
        Placeholder.configure({
          placeholder,
          showOnlyWhenEditable: true,
        }),
        CharacterCount.configure({
          limit: null,
        }),
        Dropcursor.configure({
          color: '#ff0000',
          width: 2,
        }),
        Gapcursor,
        Typography,
        Mathematics,
      ];

      if (autoSave && ydoc) {
        baseExtensions.push(
          Collaboration.configure({
            document: ydoc,
            field: 'content',
          })
        );
      }

      return baseExtensions;
    }, [autoSave, ydoc, placeholder]);

    const editor = useEditor({
      onCreate({ editor }) {
        if (useStore) {
          setEditor(editor);
        }
        if (onEditorReady) {
          onEditorReady(editor);
        }
        
        if (autoSave && ydoc && isSynced) {
          ydoc.transact(() => {
            const meta = ydoc.getMap('meta');
            if (!meta.has('initialized')) {
              editor.commands.setContent(content);
              meta.set('initialized', true);
            }
          });
        }
        if (onStatsChange && showWordCount) {
          const text = editor.getText();
          const words = text.split(/\s+/).filter(word => word.length > 0).length;
          const characters = editor.storage.characterCount.characters();
          onStatsChange({ words, characters });
        }
      },
      onDestroy() {
        if (useStore) {
          setEditor(null);
        }
        if (pendingUpdates.current) {
          clearTimeout(pendingUpdates.current);
        }
        saveContent.cancel();
      },
      onUpdate({ editor }) {
        if (useStore) {
          setEditor(editor);
        }
        
        // Update stats
        if (onStatsChange && showWordCount) {
          const text = editor.getText();
          const words = text.split(/\s+/).filter(word => word.length > 0).length;
          const characters = editor.storage.characterCount.characters();
          onStatsChange({ words, characters });
        }
        
        if (autoSave) {
          setHasUnsavedChanges(true);
          if (onSaveStateChange) {
            onSaveStateChange('unsaved');
          }
          saveContent(editor);
        } else if (onChange) {
          onChange(editor.getHTML());
        }
      },
      onSelectionUpdate({ editor }) {
        if (useStore) {
          setEditor(editor);
        }
      },
      onTransaction({ editor }) {
        if (useStore) {
          setEditor(editor);
        }
      },
      onFocus({ editor }) {
        if (useStore) {
          setEditor(editor);
        }
      },
      onBlur({ editor }) {
        if (useStore) {
          setEditor(editor);
        }
        if (autoSave && hasUnsavedChanges) {
          saveContent.flush();
        }
      },
      onContentError({ editor }) {
        if (useStore) {
          setEditor(editor);
        }
      },
      extensions,
      editorProps: {
        
        attributes: {
          style: readOnly ? `min-height: ${minHeight};` : `padding-left: 56px; padding-right: 56px; min-height: ${minHeight};`,
          class: readOnly 
            ? editorClassName || 'focus:outline-none bg-transparent w-full [&_img]:w-full [&_img]:h-auto [&_img]:object-contain'
            : 'focus:outline-none bg-white dark:bg-neutral-900/0 print:border-0 bg-white flex flex-col min-h-[1054px] w-[816px] pt-10 pr-14 pb-10 cursor-text',
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
                const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY });
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
      content,
      editable: !readOnly,
      immediatelyRender: false,
    })

    useEffect(() => {
      if (editor && content !== editor.getHTML() && !autoSave) {
        editor.commands.setContent(content);
      }
    }, [content, editor, autoSave]);

    useEffect(() => {
      if (editor && autoSave && ydoc && isSynced) {
        ydoc.transact(() => {
          const meta = ydoc.getMap('meta');
          if (!meta.has('initialized')) {
            const currentHTML = editor.getHTML().trim();
            if (currentHTML === '' || currentHTML === '<p></p>') {
              editor.commands.setContent(content);
            }
            meta.set('initialized', true);
          }
        });
      }
    }, [editor, autoSave, ydoc, isSynced, content]);

    useEffect(() => {
      if (editor) {
        editor.setEditable(!readOnly);
      }
    }, [readOnly, editor]);

    useEffect(() => {
      return () => {
        if (pendingUpdates.current) {
          clearTimeout(pendingUpdates.current);
        }
        saveContent.cancel();
      };
    }, [saveContent]);

    return (
      <div className={className}>
        {!readOnly && <Ruler/>}
        <div className="flex items-start justify-center min-h-full">
          <EditorContent editor={editor} />
        </div>
      </div>
    )
}