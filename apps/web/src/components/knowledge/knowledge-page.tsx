'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { BookOpen, Plus, Search, FolderOpen, FileText, Trash2, Eye, Edit3, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  useNotes,
  useKnowledgeSearch,
  useCreateNote,
  useUpdateNote,
  useDeleteNote,
  type Note,
  type KnowledgeSearchResult,
} from '@/hooks/knowledge/use-knowledge';

// ─── Debounce ─────────────────────────────────────────────────────────────────

function useDebounced<T>(value: T, delay = 300): T {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return dv;
}

// ─── Folder tree ──────────────────────────────────────────────────────────────

function FolderTree({
  notes,
  selected,
  onSelect,
  matchedFolders,
}: {
  notes: Note[];
  selected: string | null;
  onSelect: (folder: string | null) => void;
  matchedFolders: Set<string>;
}) {
  const folders = Array.from(new Set(notes.map((n) => n.folder_path))).sort();

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => onSelect(null)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors',
          selected === null
            ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
            : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900',
        )}
      >
        <BookOpen className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate">All notes</span>
        <span className="ml-auto text-xs text-zinc-400">{notes.length}</span>
      </button>

      {folders.map((folder) => {
        const count = notes.filter((n) => n.folder_path === folder).length;
        const isMatch = matchedFolders.has(folder);
        return (
          <button
            key={folder}
            onClick={() => onSelect(folder)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors',
              selected === folder
                ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900',
              isMatch && 'ring-1 ring-blue-400 ring-inset',
            )}
          >
            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate font-mono text-xs">{folder}</span>
            <span className="ml-auto text-xs text-zinc-400">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Note editor ──────────────────────────────────────────────────────────────

function NoteEditor({ note, onDelete }: { note: Note; onDelete: () => void }) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content_md);
  const [preview, setPreview] = useState(false);
  const update = useUpdateNote();
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when note changes
  useEffect(() => {
    setTitle(note.title);
    setContent(note.content_md);
  }, [note.id]);

  const scheduleSave = useCallback(
    (newTitle: string, newContent: string) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        update.mutate({ id: note.id, title: newTitle, content_md: newContent });
      }, 800);
    },
    [note.id, update],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <Input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            scheduleSave(e.target.value, content);
          }}
          placeholder="Note title"
          className="font-semibold border-none bg-transparent shadow-none focus-visible:ring-0 px-0 text-base"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPreview((v) => !v)}
          className="flex-shrink-0 gap-1.5"
        >
          {preview ? <Edit3 className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {preview ? 'Edit' : 'Preview'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="flex-shrink-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        {update.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400 flex-shrink-0" />}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {preview ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        ) : (
          <Textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              scheduleSave(title, e.target.value);
            }}
            placeholder="Start writing in Markdown…"
            className="min-h-full resize-none border-none bg-transparent shadow-none focus-visible:ring-0 px-0 font-mono text-sm leading-relaxed"
          />
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function KnowledgePage() {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounced(searchInput, 300);

  const { data: allNotes = [], isLoading } = useNotes();
  const { data: searchResults = [] } = useKnowledgeSearch(debouncedSearch);

  const createNote = useCreateNote();
  const deleteNote = useDeleteNote();

  const isSearching = debouncedSearch.trim().length >= 2;

  // Folders that have matched notes during search
  const matchedFolders = isSearching
    ? new Set(searchResults.map((r) => r.folder_path))
    : new Set<string>();

  // Visible notes: search results if searching, else folder-filtered
  const visibleNoteIds: Set<string> = isSearching
    ? new Set(searchResults.map((r) => r.id))
    : new Set();

  const displayNotes = isSearching
    ? allNotes.filter((n) => visibleNoteIds.has(n.id))
    : selectedFolder
    ? allNotes.filter((n) => n.folder_path === selectedFolder)
    : allNotes;

  const selectedNote = allNotes.find((n) => n.id === selectedNoteId) ?? null;

  const handleCreateNote = useCallback(async () => {
    const result = await createNote.mutateAsync({
      folder_path: selectedFolder ?? '/',
      title: 'Untitled note',
      content_md: '',
    });
    setSelectedNoteId(result.id);
  }, [createNote, selectedFolder]);

  const handleDeleteNote = useCallback(async () => {
    if (!selectedNoteId) return;
    await deleteNote.mutateAsync(selectedNoteId);
    setSelectedNoteId(null);
  }, [deleteNote, selectedNoteId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Column 1: Folder tree */}
      <div className="w-52 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col">
        <div className="px-3 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Knowledge</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <FolderTree
            notes={allNotes}
            selected={selectedFolder}
            onSelect={setSelectedFolder}
            matchedFolders={matchedFolders}
          />
        </div>
      </div>

      {/* Column 2: Note list */}
      <div className="w-72 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col">
        {/* Search + New */}
        <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
            <Input
              placeholder="Search notes…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
          <Button
            size="sm"
            onClick={handleCreateNote}
            disabled={createNote.isPending}
            className="w-full gap-1.5 h-8"
          >
            <Plus className="h-3.5 w-3.5" />
            New note
          </Button>
        </div>

        {/* Note list */}
        <div className="flex-1 overflow-y-auto">
          {displayNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 px-4 text-center gap-2">
              {isSearching ? (
                <p className="text-sm text-zinc-500">No notes match "{debouncedSearch}"</p>
              ) : allNotes.length === 0 ? (
                <>
                  <BookOpen className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                  <p className="text-sm text-zinc-500">No notes yet. Create your first note.</p>
                </>
              ) : (
                <p className="text-sm text-zinc-500">No notes in this folder.</p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {displayNotes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => setSelectedNoteId(note.id)}
                  className={cn(
                    'w-full text-left px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors',
                    selectedNoteId === note.id && 'bg-zinc-100 dark:bg-zinc-800',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <FileText className="h-3.5 w-3.5 text-zinc-400 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                        {note.title}
                      </p>
                      <p className="text-xs text-zinc-500 font-mono truncate mt-0.5">
                        {note.folder_path}
                      </p>
                      {isSearching && (
                        <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                          {(searchResults.find((r) => r.id === note.id)?.snippet ?? '').slice(0, 80)}…
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Column 3: Editor */}
      <div className="flex-1 overflow-hidden">
        {selectedNote ? (
          <NoteEditor key={selectedNote.id} note={selectedNote} onDelete={handleDeleteNote} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-400">
            <FileText className="h-10 w-10" />
            <p className="text-sm">Select a note to view or edit</p>
          </div>
        )}
      </div>
    </div>
  );
}
