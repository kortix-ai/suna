'use client';

/** The tool-permission editor — a default action plus per-tool rules (a bare
 *  action, or a map of path/command patterns to actions). */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { PermissionAction, PermissionConfig, PermissionRule } from '@kortix/sdk';
import { PlusIcon as Plus, TrashIcon as Trash2 } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useState } from 'react';
import {
  PERMISSION_ACTION_LABEL,
  PERMISSION_ACTION_ONLY_GROUP_LABEL,
  PERMISSION_ACTION_ONLY_KEYS,
  PERMISSION_ACTIONS,
  PERMISSION_KEY_HELP,
  PERMISSION_KEY_LABEL,
  PERMISSION_RULE_GROUPS,
  PERMISSION_RULE_KEYS,
} from './agent-editor-catalog';
import { EditorSection } from './agent-editor-primitives';

type PermObject = Record<string, PermissionRule | PermissionAction | undefined>;

/** Radix forbids `""` as an item value, so the inherit state carries a sentinel. */
const INHERIT = '__inherit__';

/**
 * The one allow/ask/deny picker, bound to `PermissionAction`.
 *
 * Pass `inheritLabel` where the key can fall back to the runtime default — it
 * becomes a NAMED first option. The control this replaced hid that state behind
 * clicking the already-active segment, so nothing on screen said it existed.
 * Omit it where an action is mandatory (a pattern rule always resolves).
 */
function ActionSelect({
  value,
  onChange,
  inheritLabel,
  label,
}: {
  value: PermissionAction | undefined;
  onChange: (v: PermissionAction | undefined) => void;
  inheritLabel?: string;
  label?: string;
}) {
  return (
    <Select
      value={value ?? (inheritLabel ? INHERIT : undefined)}
      onValueChange={(next) => onChange(next === INHERIT ? undefined : (next as PermissionAction))}
    >
      <SelectTrigger variant="outline" aria-label={label} className="h-8 w-[112px] text-xs">
        <SelectValue placeholder="Set…" />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel ? <SelectItem value={INHERIT}>{inheritLabel}</SelectItem> : null}
        {PERMISSION_ACTIONS.map((action) => (
          <SelectItem key={action} value={action}>
            {PERMISSION_ACTION_LABEL[action]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function asPermObject(permission: PermissionConfig | undefined): PermObject {
  if (permission && typeof permission === 'object') return { ...(permission as PermObject) };
  return {};
}

/**
 * The name of one permission key: what it lets the agent do, then the manifest
 * token in mono.
 *
 * The row used to print `external_directory` and nothing else, with the
 * sentence hidden in a tooltip. The sentence is the thing being decided, so it
 * leads; the token stays because people grep for it and hand-edit the YAML.
 */
function PermissionKeyName({ permKey }: { permKey: string }) {
  return (
    <Hint label={PERMISSION_KEY_HELP[permKey] ?? permKey} side="top">
      <span className="flex min-w-0 cursor-default items-baseline gap-2">
        <span className="text-foreground truncate text-sm">
          {PERMISSION_KEY_LABEL[permKey] ?? permKey}
        </span>
        <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{permKey}</span>
      </span>
    </Hint>
  );
}

/** One action-typed key: a bare allow/ask/deny/inherit, plus expandable
 *  pattern → action rules. */
function PermissionRuleRow({
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
  const ruleCount = Object.keys(map).length;

  const setBare = (v: PermissionAction | undefined) => onChange(v);
  const setRuleEntry = (pattern: string, action: PermissionAction) =>
    onChange({ ...map, [pattern]: action });
  const removeRuleEntry = (pattern: string) => {
    const next = { ...map };
    delete next[pattern];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const addRule = () => onChange({ ...map, '': 'deny' });
  const renameRule = (from: string, to: string) => {
    if (from === to) return;
    const next: Record<string, PermissionAction> = {};
    for (const [k, v] of Object.entries(map)) next[k === from ? to : k] = v;
    onChange(next);
  };

  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <PermissionKeyName permKey={label} />
        <div className="flex shrink-0 items-center gap-1.5">
          <ActionSelect
            value={isMap ? undefined : bare}
            onChange={setBare}
            inheritLabel="Inherit"
            label={`${PERMISSION_KEY_LABEL[label] ?? label} — default`}
          />
          {/* A word, not a slider glyph. The old icon button said nothing
              about what it opened, its pressed state was the only place the
              rule count lived, and opening it WROTE an empty `'' → deny` rule
              — so peeking at the rules dirtied the agent. It only expands now;
              "Add a pattern" inside is what writes. */}
          <Button
            type="button"
            variant={isMap || showRules ? 'secondary' : 'outline'}
            size="sm"
            className="gap-1 px-2 text-xs"
            aria-expanded={showRules}
            onClick={() => setShowRules((s) => !s)}
          >
            Rules
            {ruleCount > 0 ? <span className="tabular-nums">{ruleCount}</span> : null}
          </Button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {showRules && (
          <m.div
            key="rules"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-muted/40 space-y-1.5 rounded-md p-2">
              {ruleCount === 0 ? (
                <p className="text-muted-foreground px-1 pt-0.5 text-xs text-pretty">
                  Name a path or command to give it its own answer — everything else keeps the
                  setting above.
                </p>
              ) : null}
              {Object.entries(map).map(([pattern, action]) => (
                <div key={pattern} className="flex items-center gap-1.5">
                  <Input
                    value={pattern}
                    aria-label="Pattern"
                    placeholder="Pattern, e.g. git push"
                    variant="popover"
                    className="h-8 flex-1 font-mono text-xs"
                    onChange={(e) => renameRule(pattern, e.target.value)}
                  />
                  <ActionSelect
                    value={action}
                    label={`${pattern || 'New pattern'} — action`}
                    onChange={(v) => v && setRuleEntry(pattern, v)}
                  />
                  <Hint label="Remove rule">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove rule"
                      className="size-8"
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
                className="h-7 gap-1 px-2 text-xs"
                onClick={addRule}
              >
                <Plus className="size-3 shrink-0" /> Add a pattern
              </Button>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The whole "Tools" section — collapsed by default.
 *
 * Fourteen tools, each with a three-way action and an optional pattern list, is
 * the longest thing in the editor and the thing fewest agents change. It opens
 * behind one summary row that reports how many tools are already customized,
 * so the count is visible without expanding it.
 */
export function ToolsSection({
  permission,
  onChange,
}: {
  permission: PermissionConfig | undefined;
  onChange: (next: PermissionConfig | undefined) => void;
}) {
  // A bare string is one action applied to EVERY tool, not one customized
  // tool — the old count printed "1" for it, which read as "one tool changed"
  // when it is the widest setting available.
  const summary =
    typeof permission === 'string'
      ? `Every tool set to ${PERMISSION_ACTION_LABEL[permission as PermissionAction] ?? permission}`
      : permission && Object.keys(permission).length > 0
        ? `${Object.keys(permission).length} tool${Object.keys(permission).length === 1 ? '' : 's'} customized`
        : 'Every tool follows the runtime default';

  return (
    <EditorSection
      title="Tools"
      description="Which tools this agent may call. Allow runs it straight away, Ask pauses for your approval, Deny blocks it."
      trailing={
        <Badge variant="outline" size="sm">
          {summary}
        </Badge>
      }
    >
      {/* Open, not behind a disclosure: the page gives Tools a full column
          of its own (Marko, 2026-09-03). */}
      <div className="py-4">
        <PermissionEditor permission={permission} onChange={onChange} />
      </div>
    </EditorSection>
  );
}

function PermissionEditor({
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-foreground text-sm">Default for every tool</p>
          <p className="text-muted-foreground text-xs">
            {bareDefault
              ? 'Applies to every tool below until you override one.'
              : 'Unset — each tool follows the runtime default.'}
          </p>
        </div>
        <ActionSelect
          value={bareDefault}
          onChange={setDefault}
          inheritLabel="Unset"
          label="Default for every tool"
        />
      </div>

      {PERMISSION_RULE_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <p className="text-muted-foreground text-xs font-medium">{group.label}</p>
          <div className="divide-border/60 divide-y rounded-md border">
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
        <p className="text-muted-foreground text-xs font-medium">
          {PERMISSION_ACTION_ONLY_GROUP_LABEL}
        </p>
        <div className="divide-border/60 divide-y rounded-md border">
          {PERMISSION_ACTION_ONLY_KEYS.map((key) => (
            <div key={key} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <PermissionKeyName permKey={key} />
              <ActionSelect
                value={typeof obj[key] === 'string' ? (obj[key] as PermissionAction) : undefined}
                onChange={(v) => setKey(key, v)}
                inheritLabel="Inherit"
                label={PERMISSION_KEY_LABEL[key] ?? key}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
