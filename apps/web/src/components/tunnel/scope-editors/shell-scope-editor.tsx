'use client';

import { useTranslations } from 'next-intl';

import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ShellScope } from '../types';

const SUGGESTED_COMMANDS = ['git', 'node', 'npm', 'npx', 'pnpm', 'bun', 'python', 'ls', 'cat'];

const TIMEOUT_OPTIONS = [
  { label: '30 seconds', value: '30000' },
  { label: '60 seconds', value: '60000' },
  { label: '5 minutes', value: '300000' },
  { label: '30 minutes', value: '1800000' },
  { label: 'No limit', value: '0' },
];

interface ShellScopeEditorProps {
  scope: ShellScope;
  onChange: (scope: ShellScope) => void;
}

export function ShellScopeEditor({ scope, onChange }: ShellScopeEditorProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [commandInput, setCommandInput] = useState('');

  const addCommand = (cmd?: string) => {
    const value = (cmd || commandInput).trim();
    if (!value || scope.commands.includes(value)) return;
    onChange({ ...scope, commands: [...scope.commands, value] });
    if (!cmd) setCommandInput('');
  };

  const removeCommand = (cmd: string) => {
    onChange({ ...scope, commands: scope.commands.filter((c) => c !== cmd) });
  };

  const unusedSuggestions = SUGGESTED_COMMANDS.filter((c) => !scope.commands.includes(c));

  return (
    <div className="space-y-4">
      {/* Allowed Commands */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsTunnelScopeEditorsShellScopeEditor.line46JsxTextAllowedCommands')}</Label>
        {scope.commands.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {scope.commands.map((cmd) => (
              <Badge key={cmd} variant="secondary" className="gap-1 pr-1 font-mono text-xs">
                {cmd}
                <Button onClick={() => removeCommand(cmd)} variant="ghost" size="icon-xs" className="ml-0.5">
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <input
            type="text"
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCommand())}
            placeholder={tHardcodedUi.raw('componentsTunnelScopeEditorsShellScopeEditor.line65JsxAttrPlaceholderEGGitNodePython')}
            className="flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button variant="outline" size="sm" onClick={() => addCommand()} disabled={!commandInput.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {unusedSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {unusedSuggestions.map((cmd) => (
              <Button
                key={cmd}
                onClick={() => addCommand(cmd)}
                variant="outline"
                size="xs"
                className="border-dashed"
              >
                + {cmd}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Working Directory */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsTunnelScopeEditorsShellScopeEditor.line91JsxTextWorkingDirectory')}</Label>
        <input
          type="text"
          value={scope.workingDir || ''}
          onChange={(e) => onChange({ ...scope, workingDir: e.target.value || undefined })}
          placeholder={tHardcodedUi.raw('componentsTunnelScopeEditorsShellScopeEditor.line96JsxAttrPlaceholderHomeUserProjectOptional')}
          className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* Max Timeout */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsTunnelScopeEditorsShellScopeEditor.line103JsxTextMaxTimeout')}</Label>
        <Select
          value={String(scope.maxTimeout || 0)}
          onValueChange={(v) => {
            const num = parseInt(v, 10);
            onChange({ ...scope, maxTimeout: num || undefined });
          }}
        >
          <SelectTrigger size="sm" className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEOUT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
