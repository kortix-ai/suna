'use client';

/** The Runtime permission-tree editor — a default action plus per-key rules
 *  (bare action or glob-pattern → action maps). */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import {
  PERMISSION_ACTION_ONLY_KEYS,
  PERMISSION_KEY_HELP,
  PERMISSION_RULE_GROUPS,
  PERMISSION_RULE_KEYS,
} from './agent-editor-catalog';
import { Segmented } from './agent-editor-primitives';
import type { PermissionAction, PermissionConfig, PermissionRule } from '@kortix/sdk/projects-client';
import { AnimatePresence, motion } from 'motion/react';
import { Plus, Sliders, Trash2 } from 'lucide-react';
import { useState } from 'react';

type PermObject = Record<string, PermissionRule | PermissionAction | undefined>;

export function asPermObject(permission: PermissionConfig | undefined): PermObject {
  if (permission && typeof permission === 'object') return { ...(permission as PermObject) };
  return {};
}

/** One action-typed key: a bare allow/ask/deny/inherit, plus expandable
 *  glob-pattern → action rules. */
export function PermissionRuleRow({
  label,
  rule,
  onChange,
}: {
  label: string;
  rule: PermissionRule | PermissionAction | undefined;
  onChange: (next: PermissionRule | undefined) => void;
}) {
  const isMap = rule !== undefined && typeof rule === 'object';
  const bare = typeof rule === 'string' ? (rule as PermissionAction) : undefined;
  const map = isMap ? (rule as Record<string, PermissionAction>) : {};
  const [showRules, setShowRules] = useState(isMap);

  const setBare = (v: PermissionAction | undefined) => onChange(v);
  const setRuleEntry = (pattern: string, action: PermissionAction) =>
    onChange({ ...map, [pattern]: action });
  const removeRuleEntry = (pattern: string) => {
    const next = { ...map };
    delete next[pattern];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const addRule = () => {
    setShowRules(true);
    onChange({ ...map, '': 'deny' });
  };
  const renameRule = (from: string, to: string) => {
    if (from === to) return;
    const next: Record<string, PermissionAction> = {};
    for (const [k, v] of Object.entries(map)) next[k === from ? to : k] = v;
    onChange(next);
  };

  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <Hint label={PERMISSION_KEY_HELP[label] ?? label} side="top">
          <span className="font-mono text-xs cursor-default">{label}</span>
        </Hint>
        <div className="flex items-center gap-1.5">
          <Segmented
            options={[
              { value: 'allow', label: 'Allow' },
              { value: 'ask', label: 'Ask' },
              { value: 'deny', label: 'Deny' },
            ]}
            value={isMap ? undefined : bare}
            onChange={(v) => setBare(v)}
            allowUnset
          />
          <Hint label="Per-pattern rules">
            <Button
              type="button"
              variant={isMap || showRules ? 'secondary' : 'outline'}
              size="icon"
              className="size-7"
              onClick={() => (showRules ? setShowRules(false) : addRule())}
            >
              <Sliders className="size-3.5 shrink-0" />
            </Button>
          </Hint>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {(showRules || isMap) && (
          <motion.div
            key="rules"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-muted/40 space-y-1.5 rounded-md p-2">
              {Object.entries(map).map(([pattern, action], i) => (
                <div key={`${i}-${pattern}`} className="flex items-center gap-1.5">
                  <Input
                    value={pattern}
                    placeholder="glob e.g. git push"
                    variant="popover"
                    className="h-7 flex-1 font-mono text-xs"
                    onChange={(e) => renameRule(pattern, e.target.value)}
                  />
                  <Segmented
                    options={[
                      { value: 'allow', label: 'Allow' },
                      { value: 'ask', label: 'Ask' },
                      { value: 'deny', label: 'Deny' },
                    ]}
                    value={action}
                    onChange={(v) => v && setRuleEntry(pattern, v)}
                  />
                  <Hint label="Remove rule">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => removeRuleEntry(pattern)}
                    >
                      <Trash2 className="size-3.5 shrink-0" />
                    </Button>
                  </Hint>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={addRule}
              >
                <Plus className="size-3 shrink-0" /> Add pattern rule
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PermissionEditor({
  permission,
  onChange,
}: {
  permission: PermissionConfig | undefined;
  onChange: (next: PermissionConfig | undefined) => void;
}) {
  const obj = asPermObject(permission);
  const bareDefault = typeof permission === 'string' ? (permission as PermissionAction) : undefined;
  const allKeys = [...PERMISSION_RULE_KEYS, ...PERMISSION_ACTION_ONLY_KEYS];

  const setDefault = (v: PermissionAction | undefined) => onChange(v);
  const setKey = (key: string, value: PermissionRule | PermissionAction | undefined) => {
    const base: PermObject = bareDefault
      ? (Object.fromEntries(allKeys.map((k) => [k, bareDefault])) as PermObject)
      : obj;
    const next: PermObject = { ...base };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(Object.keys(next).length ? (next as PermissionConfig) : undefined);
  };

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground/70 text-[11px] leading-relaxed text-pretty">
        Allow runs freely, Ask pauses for human approval, Deny blocks it outright. Set a default for
        every capability below, or leave it unset and tune specific ones. The sliders control adds
        glob-pattern rules (e.g. <span className="font-mono">git push</span> → Deny while everything
        else stays Allow).
      </p>

      <div className="bg-popover flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-foreground/80 text-xs font-medium">Default for every capability</p>
          <p className="text-muted-foreground/60 text-[11px]">
            {bareDefault
              ? 'Applies to every capability below until you override one.'
              : 'Unset — each capability inherits the runtime default.'}
          </p>
        </div>
        <Segmented
          options={[
            { value: 'allow', label: 'Allow' },
            { value: 'ask', label: 'Ask' },
            { value: 'deny', label: 'Deny' },
          ]}
          value={bareDefault}
          onChange={setDefault}
          allowUnset
        />
      </div>

      {PERMISSION_RULE_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <p className="text-muted-foreground/70 text-[10px] font-medium tracking-wide uppercase">
            {group.label}
          </p>
          <div className="bg-popover divide-border/60 divide-y rounded-md border">
            {group.keys.map((key) => (
              <PermissionRuleRow
                key={key}
                label={key}
                rule={obj[key]}
                onChange={(next) => setKey(key, next)}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="space-y-1.5">
        <p className="text-muted-foreground/70 text-[10px] font-medium tracking-wide uppercase">
          Action-only
        </p>
        <div className="bg-popover divide-border/60 divide-y rounded-md border">
          {PERMISSION_ACTION_ONLY_KEYS.map((key) => (
            <div key={key} className="flex items-center justify-between gap-2 px-3 py-2.5">
              <Hint label={PERMISSION_KEY_HELP[key] ?? key} side="top">
                <span className="font-mono text-xs cursor-default">{key}</span>
              </Hint>
              <Segmented
                options={[
                  { value: 'allow', label: 'Allow' },
                  { value: 'ask', label: 'Ask' },
                  { value: 'deny', label: 'Deny' },
                ]}
                value={typeof obj[key] === 'string' ? (obj[key] as PermissionAction) : undefined}
                onChange={(v) => setKey(key, v)}
                allowUnset
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
