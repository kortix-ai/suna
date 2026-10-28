'use client';

import { useTranslations as useI18nTranslations } from '../../../i18n';
/** The tool-permission editor — a default action plus per-tool rules (a bare
 *  action, or a map of path/command patterns to actions). */

import { Button } from '../../../primitives/button';
import Hint from '../../../primitives/hint';
import { Input } from '../../../primitives/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../primitives/select';
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
import { SettingsRow, SettingsRowGroup } from '../../../primitives/settings-row';
import { SettingsSubsectionHeader } from '../../../primitives/settings-subsection-header';
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <Select
      value={value ?? (inheritLabel ? INHERIT : undefined)}
      onValueChange={(next) => onChange(next === INHERIT ? undefined : (next as PermissionAction))}
    >
      <SelectTrigger variant="outline" aria-label={label} className="h-8 w-[112px] text-xs">
        <SelectValue placeholder={tI18nComplete.raw('text1ad7a1e28408')} />
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
        <span className="text-muted-foreground shrink-0 font-mono text-xs">{permKey}</span>
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  // One rule is a default plus patterns. Alone, the default is a bare action;
  // with patterns it is the map's `*` entry, the form both harnesses read.
  const isMap = rule !== undefined && typeof rule === 'object';
  const full = isMap ? (rule as Record<string, PermissionAction>) : {};
  const bare = typeof rule === 'string' ? (rule as PermissionAction) : full['*'];
  const map = Object.fromEntries(Object.entries(full).filter(([pattern]) => pattern !== '*'));
  const [showRules, setShowRules] = useState(isMap);
  const ruleCount = Object.keys(map).length;

  /** Write a default and patterns back in the smallest form. */
  const write = (fallback: PermissionAction | undefined, patterns: Record<string, PermissionAction>) => {
    if (Object.keys(patterns).length === 0) return onChange(fallback);
    onChange(fallback ? { ...patterns, '*': fallback } : patterns);
  };
  const setBare = (v: PermissionAction | undefined) => write(v, map);
  const setRuleEntry = (pattern: string, action: PermissionAction) => write(bare, { ...map, [pattern]: action });
  const removeRuleEntry = (pattern: string) => {
    const next = { ...map };
    delete next[pattern];
    write(bare, next);
  };
  const addRule = () => write(bare, { ...map, '': 'deny' });
  const renameRule = (from: string, to: string) => {
    if (from === to) return;
    const next: Record<string, PermissionAction> = {};
    for (const [k, v] of Object.entries(map)) next[k === from ? to : k] = v;
    write(bare, next);
  };

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <PermissionKeyName permKey={label} />
        <div className="flex shrink-0 items-center gap-1.5">
          <ActionSelect
            value={bare}
            onChange={setBare}
            inheritLabel={tI18nComplete.raw('text3f72f0385768')}
            label={tI18nComplete('textfaaaefbff336', {
              value0: PERMISSION_KEY_LABEL[label] ?? label,
            })}
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
            {tI18nComplete.raw('text4228aeb07c41')}
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
                  {tI18nComplete.raw('text8d1833ac5f65')}
                </p>
              ) : null}
              {Object.entries(map).map(([pattern, action]) => (
                <div key={pattern} className="flex items-center gap-1.5">
                  <Input
                    value={pattern}
                    aria-label={tI18nComplete.raw('text4288ade73ff9')}
                    placeholder={tI18nComplete.raw('textcf134a1de504')}
                    variant="popover"
                    className="h-8 flex-1 font-mono text-xs"
                    onChange={(e) => renameRule(pattern, e.target.value)}
                  />
                  <ActionSelect
                    value={action}
                    label={tI18nComplete('text494cb0162c19', {
                      value0: pattern || tI18nComplete.raw('textc6fbcde46fa9'),
                    })}
                    onChange={(v) => v && setRuleEntry(pattern, v)}
                  />
                  <Hint label={tI18nComplete.raw('text3fab7379af90')}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={tI18nComplete.raw('text3fab7379af90')}
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
                <Plus className="size-3 shrink-0" /> {tI18nComplete.raw('textcb23e849693a')}
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
  title,
}: {
  permission: PermissionConfig | undefined;
  onChange: (next: PermissionConfig | undefined) => void;
  /** Set when the section sits under another lead section (the tool switches): it becomes a subsection with this title. */
  title?: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
      title={title ?? tI18nComplete.raw('textea93d6a262ec')}
      description={tI18nComplete.raw('text765f388e2ce6')}
      lead={title === undefined}
      bare
    >
      {/* Open, not behind a disclosure: the page gives Tools a full column
          of its own (Marko, 2026-09-03). */}
      <PermissionEditor permission={permission} onChange={onChange} summary={summary} />
    </EditorSection>
  );
}

function PermissionEditor({
  permission,
  onChange,
  summary,
}: {
  permission: PermissionConfig | undefined;
  onChange: (next: PermissionConfig | undefined) => void;
  /** What the rules add up to, under the default row's label. */
  summary: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
    <div className="space-y-8">
      <SettingsRowGroup>
        <SettingsRow
          label={tI18nComplete.raw('text9b99443d24c5')}
          description={
            bareDefault
              ? tI18nComplete.raw('textabba11786cee')
              : Object.keys(obj).length > 0
                ? `${summary}.`
                : tI18nComplete.raw('texte640da5d14fd')
          }
        >
          <ActionSelect
            value={bareDefault}
            onChange={setDefault}
            inheritLabel={tI18nComplete.raw('text8d2dd4e8c7ca')}
            label={tI18nComplete.raw('text9b99443d24c5')}
          />
        </SettingsRow>
      </SettingsRowGroup>

      {PERMISSION_RULE_GROUPS.map((group) => (
        <section key={group.label} className="space-y-3">
          <SettingsSubsectionHeader title={group.label} />
          <div className="bg-popover divide-border divide-y rounded-md border">
            {group.keys.map((key) => (
              <PermissionRuleRow
                key={key}
                label={key}
                rule={obj[key]}
                onChange={(next) => setKey(key, next)}
              />
            ))}
          </div>
        </section>
      ))}

      <section className="space-y-3">
        <SettingsSubsectionHeader title={PERMISSION_ACTION_ONLY_GROUP_LABEL} />
        <div className="bg-popover divide-border divide-y rounded-md border">
          {PERMISSION_ACTION_ONLY_KEYS.map((key) => (
            <div key={key} className="flex items-center justify-between gap-3 px-4 py-3">
              <PermissionKeyName permKey={key} />
              <ActionSelect
                value={typeof obj[key] === 'string' ? (obj[key] as PermissionAction) : undefined}
                onChange={(v) => setKey(key, v)}
                inheritLabel={tI18nComplete.raw('text3f72f0385768')}
                label={PERMISSION_KEY_LABEL[key] ?? key}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
