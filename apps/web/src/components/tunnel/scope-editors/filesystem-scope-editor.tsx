'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import React, { useState } from 'react';
import { X, Plus, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { FilesystemScope } from '../types';

const ALL_OPERATIONS = ['read', 'write', 'list', 'delete'] as const;

const MAX_FILE_SIZE_OPTIONS = [
  { label: 'No limit', value: '0' },
  { label: '1 MB', value: '1048576' },
  { label: '10 MB', value: '10485760' },
  { label: '50 MB', value: '52428800' },
  { label: '100 MB', value: '104857600' },
];

interface FilesystemScopeEditorProps {
  scope: FilesystemScope;
  onChange: (scope: FilesystemScope) => void;
}

export function FilesystemScopeEditor({ scope, onChange }: FilesystemScopeEditorProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [pathInput, setPathInput] = useState('');
  const [excludeInput, setExcludeInput] = useState('');
  const [excludesOpen, setExcludesOpen] = useState((scope.excludePatterns?.length ?? 0) > 0);

  const toggleOperation = (op: (typeof ALL_OPERATIONS)[number]) => {
    const current = scope.operations || [];
    const next = current.includes(op)
      ? current.filter((o) => o !== op)
      : [...current, op];
    onChange({ ...scope, operations: next });
  };

  const addPath = () => {
    const trimmed = pathInput.trim();
    if (!trimmed || scope.paths.includes(trimmed)) return;
    onChange({ ...scope, paths: [...scope.paths, trimmed] });
    setPathInput('');
  };

  const removePath = (path: string) => {
    onChange({ ...scope, paths: scope.paths.filter((p) => p !== path) });
  };

  const addExclude = () => {
    const trimmed = excludeInput.trim();
    if (!trimmed) return;
    const existing = scope.excludePatterns || [];
    if (existing.includes(trimmed)) return;
    onChange({ ...scope, excludePatterns: [...existing, trimmed] });
    setExcludeInput('');
  };

  const removeExclude = (pattern: string) => {
    onChange({
      ...scope,
      excludePatterns: (scope.excludePatterns || []).filter((p) => p !== pattern),
    });
  };

  return (
    <div className="space-y-4">
      {/* Operations */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Operations</Label>
        <div className="flex flex-wrap gap-3">
          {ALL_OPERATIONS.map((op) => (
            <label key={op} className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox
                checked={scope.operations?.includes(op) ?? false}
                onCheckedChange={() => toggleOperation(op)}
              />
              <span className="text-sm capitalize">{op}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Allowed Paths */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsTunnelScopeEditorsFilesystemScopeEditor.line89JsxTextAllowedPaths')}</Label>
        {scope.paths.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {scope.paths.map((p) => (
              <Badge key={p} variant="secondary" className="gap-1 pr-1 font-mono text-xs">
                {p}
                <Button onClick={() => removePath(p)} variant="ghost" size="icon-xs" className="ml-0.5">
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addPath())}
            placeholder="/home/user/projects"
            className="flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button variant="outline" size="sm" onClick={addPath} disabled={!pathInput.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Exclude Patterns (collapsible) */}
      <Collapsible open={excludesOpen} onOpenChange={setExcludesOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', excludesOpen ? '' : '-rotate-90')} />{tHardcodedUi.raw('componentsTunnelScopeEditorsFilesystemScopeEditor.line121JsxTextExcludePatterns')}{(scope.excludePatterns?.length ?? 0) > 0 && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0">{scope.excludePatterns!.length}</Badge>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pt-2 space-y-2">
            {(scope.excludePatterns?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {scope.excludePatterns!.map((p) => (
                  <Badge key={p} variant="secondary" className="gap-1 pr-1 font-mono text-xs">
                    {p}
                    <Button onClick={() => removeExclude(p)} variant="ghost" size="icon-xs" className="ml-0.5">
                      <X className="h-3 w-3" />
                    </Button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <input
                type="text"
                value={excludeInput}
                onChange={(e) => setExcludeInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addExclude())}
                placeholder={tHardcodedUi.raw('componentsTunnelScopeEditorsFilesystemScopeEditor.line146JsxAttrPlaceholderNodeModules')}
                className="flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <Button variant="outline" size="sm" onClick={addExclude} disabled={!excludeInput.trim()}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Max File Size */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsTunnelScopeEditorsFilesystemScopeEditor.line159JsxTextMaxFileSize')}</Label>
        <Select
          value={String(scope.maxFileSize || 0)}
          onValueChange={(v) => {
            const num = parseInt(v, 10);
            onChange({ ...scope, maxFileSize: num || undefined });
          }}
        >
          <SelectTrigger size="sm" className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MAX_FILE_SIZE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
