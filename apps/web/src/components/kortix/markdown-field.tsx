'use client';

/**
 * Edit-in-place markdown field.
 *
 * One component that handles the full view → edit → save cycle used by ticket
 * bodies (and anywhere else we want the same flow: project About, persona
 * bios, etc.). Internally picks:
 *   - MentionMarkdown for view mode (full UnifiedMarkdown + @mention decorate)
 *   - MentionTextarea for edit mode (transparent textarea + overlay)
 *
 * Callers pass `value`, `onSave(next)` and the team context. The component
 * owns the local draft, the Edit / Cancel / Save buttons, and the keyboard
 * shortcuts (Cmd+S to save, Esc to cancel). Auto-grows the editor.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pencil, Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MentionMarkdown } from '@/components/kortix/mention-markdown';
import { MentionTextarea } from '@/components/kortix/mention-textarea';
import { useCurrentUserAvatarProps } from '@/components/kortix/agent-avatar';
import type { ProjectAgent } from '@/hooks/kortix/use-kortix-tickets';

export interface MarkdownFieldProps {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  agents: ProjectAgent[];
  userHandle: string;

  /** Optional if the caller knows the user's Supabase avatar (passed to the overlay's mention dropdown). */
  userAvatarUrl?: string | null;
  placeholder?: string;
  /** Disable editing entirely (read-only) — defaults to false. */
  readOnly?: boolean;
  /** When set, the "Edit" action calls this instead of toggling internally — lets a parent own `editing`. */
  editingOverride?: { editing: boolean; onChange: (v: boolean) => void };
  /** Inline-edit mode: clicking the rendered body flips to edit; no external Edit pill. */
  clickToEdit?: boolean;
  /** Where to render the Edit / Save / Cancel buttons ("slot" returns them so the parent can place them). */
  toolbar?: 'inline' | 'slot';
  onToolbar?: (el: React.ReactNode) => void;

  /** Extra class on the container. */
  className?: string;
  /** Min height of the editor in px — defaults to 200. */
  minHeight?: number;
  /** Submit on Cmd/Ctrl+Enter as well as Cmd/Ctrl+S. */
  saveOnCmdEnter?: boolean;
}

export function MarkdownField({
  value,
  onSave,
  agents,
  userHandle,
  userAvatarUrl,
  placeholder = 'Write markdown… type @ to tag a team member.',
  readOnly,
  editingOverride,
  clickToEdit,
  className,
  minHeight = 200,
  saveOnCmdEnter,
}: MarkdownFieldProps) {
  const [localEditing, setLocalEditing] = useState(false);
  const editing = editingOverride?.editing ?? localEditing;
  const setEditing = (v: boolean) => {
    if (editingOverride) editingOverride.onChange(v);
    else setLocalEditing(v);
  };

  // Always initialise to a string so the underlying <textarea> is controlled
  // from the very first render. value can briefly be undefined while its
  // useTicket query resolves — an undefined-then-string transition is what
  // React warns about as "uncontrolled → controlled".
  const [draft, setDraft] = useState<string>(value ?? '');
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { avatarUrl: selfAvatar } = useCurrentUserAvatarProps();
  const avatar = userAvatarUrl ?? selfAvatar;

  // Mirror the latest saved value into the draft when we're not editing.
  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  // Focus + auto-grow when entering edit mode.
  useEffect(() => {
    if (editing) setTimeout(() => textRef.current?.focus(), 0);
  }, [editing]);
  useLayoutEffect(() => {
    if (!editing) return;
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [editing, draft, minHeight]);

  const startEdit = () => {
    if (readOnly) return;
    setDraft(value);
    setEditing(true);
  };
  const cancel = () => { setDraft(value); setEditing(false); };
  const save = async () => {
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); setEditing(false); }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if ((e.key === 's' && (e.metaKey || e.ctrlKey)) ||
        (saveOnCmdEnter && e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault(); save();
    }
  };

  if (editing) {
    return (
      <div className={cn('rounded-xl border border-border/40 bg-card focus-within:border-primary/30 focus-within:ring-1 focus-within:ring-primary/20 transition-colors', className)}>
        <MentionTextarea
          ref={textRef}
          value={draft}
          onChange={setDraft}
          onKeyDown={onKey}
          agents={agents}
          userHandle={userHandle}
          userAvatarUrl={avatar}
          placeholder={placeholder}
          className={cn(
            'w-full resize-none overflow-hidden border-0 outline-none px-5 py-4',
            'text-[13px] leading-[1.7] font-mono',
            'placeholder:text-muted-foreground/30',
          )}
        />
        <div className="flex items-center gap-1 px-3 py-2 border-t border-border/30">
          <span className="text-[10px] text-muted-foreground/45">
            <kbd className="inline-flex items-center min-w-[18px] h-4 px-1 rounded border border-border/50 bg-muted/40 text-[10px] font-mono">⌘</kbd>
            <kbd className="inline-flex items-center min-w-[18px] h-4 px-1 ml-0.5 rounded border border-border/50 bg-muted/40 text-[10px] font-mono">S</kbd>
            <span className="ml-1.5">save · Esc cancel</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost" size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={cancel}
              disabled={saving}
            >
              <X className="h-3 w-3 mr-0.5" />
              Cancel
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-6 px-2 text-[11px] text-emerald-500 hover:text-emerald-400 gap-1"
              onClick={save}
              disabled={saving || draft === value}
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // View mode.
  if (clickToEdit && !readOnly) {
    return (
      <button
        type="button"
        onClick={startEdit}
        className={cn('block w-full text-left group cursor-text rounded-xl', className)}
        aria-label="Edit"
      >
        {value.trim() ? (
          <MentionMarkdown content={value} agents={agents} userHandle={userHandle} />
        ) : (
          <div className="rounded-xl border border-dashed border-border/50 p-8 text-center hover:border-border hover:bg-muted/20 transition-colors">
            <p className="text-[12.5px] text-muted-foreground/55">{placeholder}</p>
          </div>
        )}
      </button>
    );
  }

  return (
    <div className={cn('group relative', className)}>
      {value.trim() ? (
        <div className="rounded-xl border border-border/40 bg-card px-5 sm:px-6 py-5">
          <MentionMarkdown content={value} agents={agents} userHandle={userHandle} />
        </div>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          disabled={readOnly}
          className="w-full rounded-xl border border-dashed border-border/50 p-8 text-center hover:border-border hover:bg-muted/20 transition-colors cursor-pointer"
        >
          <p className="text-[12.5px] text-muted-foreground/55">{placeholder}</p>
        </button>
      )}
      {!readOnly && value.trim() && (
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-2 right-2 h-6 px-2 text-[11px] text-muted-foreground/40 hover:text-foreground gap-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={startEdit}
        >
          <Pencil className="h-3 w-3" />
          Edit
        </Button>
      )}
    </div>
  );
}
