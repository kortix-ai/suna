'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  folder_path: string;
  title: string;
  content_md: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  folder_path: string;
  snippet: string;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchNotes(folderPath?: string): Promise<Note[]> {
  const params = folderPath ? `?folder_path=${encodeURIComponent(folderPath)}` : '';
  const res = await backendApi.get<{ notes: Note[] }>(`/knowledge${params}`);
  return res.data?.notes ?? [];
}

async function fetchNote(id: string): Promise<Note | null> {
  const res = await backendApi.get<{ note: Note }>(`/knowledge/${id}`);
  return res.data?.note ?? null;
}

async function createNote(data: { folder_path?: string; title: string; content_md?: string }): Promise<Note> {
  const res = await backendApi.post<{ note: Note }>('/knowledge', data);
  if (!res.data?.note) throw new Error('Create failed');
  return res.data.note;
}

async function updateNote(id: string, data: Partial<Pick<Note, 'folder_path' | 'title' | 'content_md'>>): Promise<Note> {
  const res = await backendApi.put<{ note: Note }>(`/knowledge/${id}`, data);
  if (!res.data?.note) throw new Error('Update failed');
  return res.data.note;
}

async function deleteNote(id: string): Promise<void> {
  await backendApi.delete(`/knowledge/${id}`);
}

async function searchNotes(q: string): Promise<KnowledgeSearchResult[]> {
  if (!q.trim()) return [];
  const res = await backendApi.get<{ results: KnowledgeSearchResult[] }>(
    `/knowledge/search?q=${encodeURIComponent(q)}`,
  );
  return res.data?.results ?? [];
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

const KEYS = {
  all: ['knowledge'] as const,
  list: (folder?: string) => ['knowledge', 'list', folder ?? ''] as const,
  note: (id: string) => ['knowledge', 'note', id] as const,
  search: (q: string) => ['knowledge', 'search', q] as const,
};

export function useNotes(folderPath?: string) {
  return useQuery({
    queryKey: KEYS.list(folderPath),
    queryFn: () => fetchNotes(folderPath),
    staleTime: 30_000,
  });
}

export function useNote(id: string | null) {
  return useQuery({
    queryKey: KEYS.note(id!),
    queryFn: () => fetchNote(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useKnowledgeSearch(q: string) {
  return useQuery({
    queryKey: KEYS.search(q),
    queryFn: () => searchNotes(q),
    enabled: q.trim().length >= 2,
    staleTime: 10_000,
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createNote,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Pick<Note, 'folder_path' | 'title' | 'content_md'>>) =>
      updateNote(id, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: KEYS.all });
      qc.invalidateQueries({ queryKey: KEYS.note(vars.id) });
    },
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteNote,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}
