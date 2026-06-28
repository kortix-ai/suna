'use client';

import { useTranslations } from 'next-intl';

/**
 * SecretsManager — simple raw KV editor for sandbox environment variables.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  Eye,
  EyeOff,
  Pencil,
  Trash2,
  Plus,
  Check,
  X,
  Loader2,
  Search,
  KeyRound,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { List } from '@/components/ui/list';
import { useSecrets, useSetSecret, useDeleteSecret } from '@/hooks/secrets/use-secrets';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function SecretsManager() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: secrets, isLoading } = useSecrets();
  const setSecret = useSetSecret();
  const deleteSecret = useDeleteSecret();

  const [search, setSearch] = useState('');
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addingNew, setAddingNew] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!secrets) return [];
    let entries = Object.entries(secrets).map(([key, value]) => ({
      key,
      value,
      hasValue: !!value && value !== '',
    }));
    if (search) {
      const q = search.toLowerCase();
      entries = entries.filter((e) => e.key.toLowerCase().includes(q));
    }
    return entries;
  }, [secrets, search]);

  const toggleReveal = useCallback((key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const handleSave = useCallback(async (key: string, value: string) => {
    try {
      await setSecret.mutateAsync({ key, value });
      setEditingKey(null);
      setEditValue('');
      toast.success(`Saved ${key}`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    }
  }, [setSecret]);

  const handleDelete = useCallback(async (key: string) => {
    setConfirmDeleteKey(null);
    try {
      await deleteSecret.mutateAsync(key);
      toast.success(`Removed ${key}`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to remove');
    }
  }, [deleteSecret]);

  const handleAddNew = useCallback(async () => {
    const k = newKey.trim();
    const v = newValue.trim();
    if (!k) return;
    try {
      await setSecret.mutateAsync({ key: k, value: v });
      setAddingNew(false);
      setNewKey('');
      setNewValue('');
      toast.success(`Added ${k}`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to add');
    }
  }, [newKey, newValue, setSecret]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div>
        {/* Header: Search + Add */}
        <div className="px-3 py-2 flex items-center gap-2 border-b border-border/50">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tHardcodedUi.raw('componentsSecretsSecretsManager.line118JsxAttrPlaceholderFilterKeys')}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Button
            variant="outline" size="sm"
            className="text-xs flex-shrink-0"
            onClick={() => setAddingNew(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add
          </Button>
        </div>

        {/* Add new row */}
        {addingNew && (
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/20 border-b border-border/20">
            <Input type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="KEY_NAME"
              className="h-7 text-xs font-mono w-[220px]"
              autoFocus
            />
            <Input type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value"
              className="h-7 text-xs font-mono flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddNew();
                if (e.key === 'Escape') { setAddingNew(false); setNewKey(''); setNewValue(''); }
              }}
            />
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <Button
                size="icon" variant="ghost" className="h-7 w-7"
                onClick={handleAddNew}
                disabled={!newKey.trim() || setSecret.isPending}
              >
                {setSecret.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              </Button>
              <Button
                size="icon" variant="ghost" className="h-7 w-7"
                onClick={() => { setAddingNew(false); setNewKey(''); setNewValue(''); }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}

        {/* Rows */}
        <List className="divide-y-0">
          {rows.map((row) => {
            const isEditing = editingKey === row.key;
            const isRevealed = revealedKeys.has(row.key);
            const isConfirmingDelete = confirmDeleteKey === row.key;

            return (
              <li
                key={row.key}
                className="flex items-center gap-3 px-3 py-2 group hover:bg-muted/30 transition-colors"
              >
                {/* Key name */}
                <code className={cn(
                  'text-xs font-mono w-[220px] flex-shrink-0 truncate',
                  row.hasValue ? 'text-foreground' : 'text-muted-foreground/60',
                )}>
                  {row.key}
                </code>

                {/* Value area */}
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <Input type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      placeholder={tHardcodedUi.raw('componentsSecretsSecretsManager.line196JsxAttrPlaceholderEnterValue')}
                      className="h-7 text-xs font-mono"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSave(row.key, editValue);
                        if (e.key === 'Escape') { setEditingKey(null); setEditValue(''); }
                      }}
                    />
                  ) : isConfirmingDelete ? (
                    <span className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsSecretsSecretsManager.line205JsxTextRemoveThisKey')}</span>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <code className={cn(
                        'text-xs font-mono truncate',
                        row.hasValue ? 'text-muted-foreground' : 'text-muted-foreground/30'
                      )}>
                        {row.hasValue ? (isRevealed ? row.value : '········') : 'empty'}
                      </code>
                      {row.hasValue && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => toggleReveal(row.key)}
                          className="h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          {isRevealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {/* Actions — always right-aligned */}
                <div className="flex items-center gap-0.5 flex-shrink-0 w-[60px] justify-end">
                  {isEditing ? (
                    <>
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() => handleSave(row.key, editValue)}
                        disabled={setSecret.isPending}
                      >
                        {setSecret.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      </Button>
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() => { setEditingKey(null); setEditValue(''); }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </>
                  ) : isConfirmingDelete ? (
                    <>
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() => handleDelete(row.key)}
                        disabled={deleteSecret.isPending}
                      >
                        {deleteSecret.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      </Button>
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() => setConfirmDeleteKey(null)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="icon" variant="ghost"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => { setEditingKey(row.key); setEditValue(''); setConfirmDeleteKey(null); }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon" variant="ghost"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => { setConfirmDeleteKey(row.key); setEditingKey(null); }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </List>

        {rows.length === 0 && !addingNew && (
          <EmptyState
            icon={KeyRound}
            size="sm"
            title={search ? 'No matches' : 'No secrets yet'}
            description={
              search ? 'No secrets match your filter.' : 'No secrets configured yet.'
            }
          />
        )}
      </div>
    </div>
  );
}
