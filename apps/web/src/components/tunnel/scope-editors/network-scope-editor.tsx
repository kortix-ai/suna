'use client';

import { useTranslations } from 'next-intl';

import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { NetworkScope } from '../types';

const ALL_PROTOCOLS = ['http', 'tcp'] as const;

interface NetworkScopeEditorProps {
  scope: NetworkScope;
  onChange: (scope: NetworkScope) => void;
}

export function NetworkScopeEditor({ scope, onChange }: NetworkScopeEditorProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [portInput, setPortInput] = useState('');
  const [hostInput, setHostInput] = useState('');

  const toggleProtocol = (proto: (typeof ALL_PROTOCOLS)[number]) => {
    const current = scope.protocols || [];
    const next = current.includes(proto)
      ? current.filter((p) => p !== proto)
      : [...current, proto];
    onChange({ ...scope, protocols: next });
  };

  const addPort = () => {
    const num = parseInt(portInput.trim(), 10);
    if (isNaN(num) || num < 1 || num > 65535 || scope.ports.includes(num)) return;
    onChange({ ...scope, ports: [...scope.ports, num] });
    setPortInput('');
  };

  const removePort = (port: number) => {
    onChange({ ...scope, ports: scope.ports.filter((p) => p !== port) });
  };

  const addHost = () => {
    const trimmed = hostInput.trim();
    if (!trimmed || scope.hosts.includes(trimmed)) return;
    onChange({ ...scope, hosts: [...scope.hosts, trimmed] });
    setHostInput('');
  };

  const removeHost = (host: string) => {
    onChange({ ...scope, hosts: scope.hosts.filter((h) => h !== host) });
  };

  return (
    <div className="space-y-4">
      {/* Protocols */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Protocols</Label>
        <div className="flex gap-3">
          {ALL_PROTOCOLS.map((proto) => (
            <label key={proto} className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox
                checked={scope.protocols?.includes(proto) ?? false}
                onCheckedChange={() => toggleProtocol(proto)}
              />
              <span className="text-sm uppercase">{proto}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Ports */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Ports</Label>
        {scope.ports.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {scope.ports.map((port) => (
              <Badge key={port} variant="secondary" className="gap-1 pr-1 font-mono text-xs">
                {port}
                <Button onClick={() => removePort(port)} variant="ghost" size="icon-xs" className="ml-0.5">
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <input
            type="number"
            min={1}
            max={65535}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addPort())}
            placeholder={tHardcodedUi.raw('componentsTunnelScopeEditorsNetworkScopeEditor.line93JsxAttrPlaceholderEG30008080')}
            className="w-[140px] rounded-2xl border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button variant="outline" size="sm" onClick={addPort} disabled={!portInput.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Hosts */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Hosts</Label>
        {scope.hosts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {scope.hosts.map((host) => (
              <Badge key={host} variant="secondary" className="gap-1 pr-1 font-mono text-xs">
                {host}
                <Button onClick={() => removeHost(host)} variant="ghost" size="icon-xs" className="ml-0.5">
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <input
            type="text"
            value={hostInput}
            onChange={(e) => setHostInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addHost())}
            placeholder={tHardcodedUi.raw('componentsTunnelScopeEditorsNetworkScopeEditor.line123JsxAttrPlaceholderEGLocalhost127001')}
            className="flex-1 rounded-2xl border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button variant="outline" size="sm" onClick={addHost} disabled={!hostInput.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
