'use client';

/**
 * The agent page's Overview tab: the agent at a glance.
 *
 * Main column, in reading order: who it is (the description and one generated
 * sentence whose nouns link to their Access view), what it does (its
 * instructions, edited in place as a formatted document). What it may touch,
 * its model, workspace and triggers are rail rows, and who may use it is the
 * header's Share: the Overview repeats none of them. The description and the
 * instructions write the page's draft in place; there is no separate editor.
 * The inspector beside it runs the page's full height behind one hairline:
 * Properties (the switches a person flips most), how the agent shows in the
 * picker, and where it is saved. Below `lg` it stacks under the document.
 *
 * One component for the editable and the read-only page. With `editor` the
 * aside's switches and selects write the shared draft; without it they show
 * their values.
 */

import type { AgentCapabilityGrant, AgentConfigBlock, ProjectConfigSummary } from '@kortix/sdk';
import {
  BookOpenTextIcon,
  CommandIcon,
  CpuIcon,
  CubeIcon,
  EyedropperIcon,
  FileTextIcon,
  GlobeIcon,
  HardDriveIcon,
  type Icon,
  KeyIcon,
  PlugsConnectedIcon,
  PencilSimpleIcon,
  PuzzlePieceIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
  TimerIcon,
  TreeStructureIcon,
  UsersIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { cn } from '../../internal/lib/utils';
import { Input } from '../../primitives/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../primitives/select';
import { StatusDot } from '../../primitives/status';
import { Switch } from '../../primitives/switch';
import { AGENT_MODE_LABEL, AGENT_MODES } from '../sections/view/agent-editor-catalog';
import { EditorSection, EditorSectionStyleProvider, SettingRow } from '../sections/view/agent-editor-primitives';
import {
  type AgentConfigSectionKey,
  type AgentDraft,
} from '../sections/view/agent-editor';
import { AgentInstructions } from './agent-instructions';

type Agent = ProjectConfigSummary['agents'][number];

/** One glyph per section: the Overview rows and the Access switcher draw the same one. */
export const SECTION_ICON: Record<AgentConfigSectionKey, Icon> = {
  overview: SquaresFourIcon,
  instructions: FileTextIcon,
  people: UsersIcon,
  basics: SlidersHorizontalIcon,
  triggers: TimerIcon,
  skills: BookOpenTextIcon,
  subagents: TreeStructureIcon,
  commands: CommandIcon,
  extensions: PuzzlePieceIcon,
  connectors: PlugsConnectedIcon,
  secrets: KeyIcon,
  apps: GlobeIcon,
  drives: HardDriveIcon,
  actions: TerminalWindowIcon,
  model: CpuIcon,
  tools: WrenchIcon,
  workspace: CubeIcon,
};

/** The grant a block holds for one Access view. Drives has none in the block; `tools` omitted is every tool. */
export function grantOf(block: AgentConfigBlock, view: AgentConfigSectionKey): AgentCapabilityGrant | undefined {
  switch (view) {
    case 'actions':
      return block.kortix_permissions ?? block.kortix_cli;
    case 'skills':
    case 'connectors':
    case 'secrets':
    case 'apps':
    case 'subagents':
    case 'commands':
    case 'extensions':
      return block[view];
    case 'tools': {
      // `codemode: off` removes codemode as an exclude does, so the counts agree.
      const tools = block.tools ?? 'all';
      if (block.codemode !== 'off') return tools;
      if (tools === 'all') return { exclude: ['codemode'] };
      if (typeof tools === 'object' && !Array.isArray(tools) && 'exclude' in tools) {
        return tools.exclude.includes('codemode') ? tools : { exclude: [...tools.exclude, 'codemode'] };
      }
      return Array.isArray(tools) ? tools.filter((id) => id !== 'codemode') : tools;
    }
    default:
      return undefined;
  }
}

/** How many ids a grant names: `all` (also `{ exclude }`: all but some), a number, or 0 for None. */
export function grantCount(value: AgentCapabilityGrant | undefined): number | 'all' {
  if (value === 'all' || (value !== undefined && !Array.isArray(value) && typeof value === 'object')) return 'all';
  return Array.isArray(value) ? value.length : 0;
}

/** The names `{ exclude }` leaves out, else none. */
export function grantExcluded(value: AgentCapabilityGrant | undefined): string[] {
  return value !== undefined && !Array.isArray(value) && typeof value === 'object' ? value.exclude : [];
}

export interface OverviewFacts {
  /** The project's size of each catalog, when known: "6 of 24". */
  totals: Partial<Record<AgentConfigSectionKey, number>>;
  /** Granted connectors whose connection needs a sign-in. */
  needsSignIn: string[];
  peopleCount?: number;
  triggerCount?: number;
}

// ─── Main column ─────────────────────────────────────────────────────────────

/** Grows a textarea to its text: one line or ten, never a scrollbar. */
function fitHeight(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * The description, edited in place: a filled box with a pencil. Click it and
 * it becomes a field in the same box; Enter or leaving keeps the edit in the
 * draft, Escape puts back what was there.
 */
function AboutDescription({
  value,
  onChange,
  subagent,
}: {
  value: string;
  onChange?: (next: string) => void;
  subagent: boolean;
}) {
  const t = useI18nTranslations('agentEditor.page');
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const [editing, setEditing] = useState<string | null>(null);
  const box = 'bg-popover block w-full rounded-md border px-3 py-2.5 text-left text-sm text-pretty';
  if (!onChange) {
    return value ? (
      <p className={cn(box, 'text-foreground')}>{value}</p>
    ) : (
      <p className="text-muted-foreground text-sm">{tTabs('noDescription')}</p>
    );
  }
  if (editing !== null) {
    const finish = (keep: boolean) => {
      if (!keep) onChange(editing);
      setEditing(null);
    };
    return (
      // The field takes the box: the same inset, line and fill, so nothing moves.
      <div className="space-y-1.5">
        <textarea
          ref={fitHeight}
          autoFocus
          rows={1}
          aria-label={t('description')}
          value={value}
          placeholder={t('descriptionPlaceholder')}
          className={cn(
            box,
            'text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/50 resize-none overflow-hidden outline-none focus-visible:ring-2',
          )}
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          onChange={(e) => {
            onChange(e.target.value.replace(/\n/g, ' '));
            fitHeight(e.target);
          }}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finish(false);
            }
          }}
        />
        <p className="text-muted-foreground px-3 text-xs text-pretty">
          {subagent ? t('descriptionHelpSubagent') : t('descriptionHelp')}
        </p>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(value)}
      aria-label={t('description')}
      className={cn(
        box,
        'group/about hover:border-foreground/20 focus-visible:ring-ring/50 flex items-start gap-3 transition-colors duration-fast focus-visible:ring-2 focus-visible:outline-none',
        value ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <span className="min-w-0 flex-1">{value || t('descriptionPlaceholder')}</span>
      <PencilSimpleIcon className="text-muted-foreground group-hover/about:text-foreground mt-1.5 size-3.5 shrink-0 transition-colors duration-fast" />
    </button>
  );
}

// ─── Aside ───────────────────────────────────────────────────────────────────

const PROJECT_WIDE = '__project_wide__';
const INHERIT = '__inherit__';
const NEW_SPACE = '__new_space__';

/** A space slug from what a person typed: the API's `SPACE_SLUG_RE` shape. */
export function spaceSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * The Space select's "New space…": an inline field for a space kortix.yaml
 * does not declare yet. Enter keeps it (as a slug), Escape or an empty value
 * goes back to the select.
 */
function NewSpaceInput({ onDone }: { onDone: (slug: string | null) => void }) {
  const t = useI18nTranslations('agentEditor.tabs');
  const [value, setValue] = useState('');
  return (
    <Input
      autoFocus
      size="sm"
      aria-label={t('newSpace')}
      placeholder={t('newSpacePlaceholder')}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(spaceSlug(value) || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onDone(spaceSlug(value) || null);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone(null);
        }
      }}
    />
  );
}

/**
 * The agent's color: the brand accents as swatches, none, or any hex typed or
 * picked with the system picker. kortix.yaml stores a hex, so each swatch
 * carries the hex of its token (`visual-system.json` `color.accents`).
 */
const AGENT_COLORS = [
  { name: 'colorBlue', token: 'bg-kortix-blue', hex: '#2b91f7' }, // audit:allow stored value, the token's hex
  { name: 'colorGreen', token: 'bg-kortix-green', hex: '#199338' }, // audit:allow stored value, the token's hex
  { name: 'colorYellow', token: 'bg-kortix-yellow', hex: '#cca300' }, // audit:allow stored value, the token's hex
  { name: 'colorOrange', token: 'bg-kortix-orange', hex: '#d18b19' }, // audit:allow stored value, the token's hex
  { name: 'colorRed', token: 'bg-kortix-red', hex: '#f14b4c' }, // audit:allow stored value, the token's hex
  { name: 'colorPurple', token: 'bg-kortix-purple', hex: '#ab80d6' }, // audit:allow stored value, the token's hex
] as const;

const HEX = /^#[0-9a-f]{6}$/;

const SWATCH = cn(
  'size-5 shrink-0 cursor-pointer rounded-sm',
  'ring-offset-background transition-[scale,box-shadow] duration-fast active:scale-[0.96]',
  'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
);
const SELECTED = 'ring-foreground ring-[1.5px] ring-offset-2';

/** The color's swatch and name: the value of the Color row. */
function colorFace(value: string | undefined, t: ReturnType<typeof useI18nTranslations>) {
  const current = value?.toLowerCase();
  const named = AGENT_COLORS.find((c) => c.hex === current);
  return {
    swatch: named ? named.token : current ? undefined : 'bg-muted-foreground',
    style: current && !named ? { backgroundColor: current } : undefined,
    label: named ? t(named.name) : current ? t('colorCustom') : t('colorNone'),
  };
}

/** Swatches, then a hex field whose eyedropper opens the system picker. */
function AgentColorField({ value, onChange }: { value: string | undefined; onChange: (next: string | undefined) => void }) {
  const t = useI18nTranslations('agentEditor.tabs');
  const current = value?.toLowerCase();
  const [typed, setTyped] = useState<string | null>(null);
  const commit = (raw: string) => {
    const hex = `#${raw.replace(/^#/, '').trim().toLowerCase()}`;
    if (raw.trim() === '') onChange(undefined);
    else if (HEX.test(hex)) onChange(hex);
    setTyped(null);
  };
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label={t('color')} className="flex items-center gap-1.5">
        <button
          type="button"
          role="radio"
          aria-checked={!current}
          aria-label={t('colorNone')}
          onClick={() => onChange(undefined)}
          className={cn(SWATCH, 'bg-muted-foreground', !current && SELECTED)}
        />
        {AGENT_COLORS.map((c) => (
          <button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={current === c.hex}
            aria-label={t(c.name)}
            onClick={() => onChange(c.hex)}
            className={cn(SWATCH, c.token, current === c.hex && SELECTED)}
          />
        ))}
      </div>
      <div className="bg-secondary flex h-7 items-center gap-1.5 rounded-md px-2">
        <span className="text-muted-foreground font-mono text-xs">#</span>
        <input
          aria-label={t('color')}
          value={typed ?? current?.slice(1).toUpperCase() ?? ''}
          placeholder="—"
          maxLength={7}
          spellCheck={false}
          className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
          onChange={(e) => setTyped(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
            else if (e.key === 'Escape') setTyped(null);
          }}
        />
        {/* Any other color: the system picker, behind the eyedropper. */}
        <label aria-label={t('colorCustom')} className="text-muted-foreground hover:text-foreground relative flex size-4 cursor-pointer items-center justify-center transition-colors duration-fast">
          <EyedropperIcon className="size-3.5" />
          <input
            type="color"
            value={current && HEX.test(current) ? current : AGENT_COLORS[0].hex}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>
    </div>
  );
}

/** The value side of a Source row: a mono path, right-aligned. */
function SourceValue({ value }: { value: string }) {
  return (
    <p className="text-foreground truncate font-mono text-xs sm:text-right" title={value}>
      {value}
    </p>
  );
}

/**
 * Below the instructions, in the Settings dialect (`EditorSection`, `panel`
 * style): Properties (the switches a person flips most), how the agent shows
 * in the picker, and where it is saved. A title per group, rows in one
 * bordered group, no sentence under a title.
 */
function OverviewSettings({
  agent,
  config,
  block,
  editor,
  showSpace,
  sourcePath,
}: {
  agent: Agent;
  config: ProjectConfigSummary;
  block: AgentConfigBlock;
  editor?: AgentDraft;
  /** The Space row: only with spaces on (`project_channels`, Work in progress). */
  showSpace: boolean;
  sourcePath: string;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const behavior = block.behavior ?? {};
  const enabled = block.enabled !== false;
  const shown = !behavior.hidden;
  // Editable: the draft alone, so choosing Project-wide shows Project-wide
  // (the save drops the key, which clears it). Read-only: the served block,
  // which already carries the agent's space.
  const space = (editor ? block.space : (block.space ?? agent.space)) || null;
  const [addingSpace, setAddingSpace] = useState(false);
  const spaces = config.spaces ?? [];
  const spaceNames = new Set(spaces.map((s) => s.name));
  const modeLabel = behavior.mode ? AGENT_MODE_LABEL[behavior.mode] : t('modeDefault');
  const face = colorFace(behavior.color, t);
  const value = (text: string) => <p className="text-foreground text-sm sm:text-right">{text}</p>;
  return (
    <>
      <EditorSection title={t('properties')}>
        <SettingRow label={t('enabled')} help={t('enabledHelp', { name: agentDisplayName(agent.name) })}>
          <div className="flex sm:justify-end">
            {editor ? (
              <Switch aria-label={t('enabled')} checked={enabled} onCheckedChange={(v) => editor.set('enabled', v ? undefined : false)} />
            ) : (
              <span className="text-foreground flex items-center gap-1.5 text-sm">
                <StatusDot tone={enabled ? 'success' : 'neutral'} />
                {enabled ? t('statusEnabled') : t('statusDisabled')}
              </span>
            )}
          </div>
        </SettingRow>
        <SettingRow label={t('whoStarts')}>
          {editor ? (
            <Select
              value={behavior.mode ?? INHERIT}
              onValueChange={(v) => editor.setOc('mode', v === INHERIT ? undefined : (v as (typeof AGENT_MODES)[number]))}
            >
              <SelectTrigger aria-label={t('whoStarts')} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>{t('modeDefault')}</SelectItem>
                {AGENT_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {AGENT_MODE_LABEL[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            value(modeLabel)
          )}
        </SettingRow>
        <SettingRow label={t('showInPickers')} help={t('showInPickersHelp')}>
          <div className="flex sm:justify-end">
            {editor ? (
              <Switch aria-label={t('showInPickers')} checked={shown} onCheckedChange={(v) => editor.setOc('hidden', v ? undefined : true)} />
            ) : (
              value(shown ? t('pickerShown') : t('pickerHidden'))
            )}
          </div>
        </SettingRow>
        {showSpace ? (
          <SettingRow label={t('space')}>
            {editor ? (
              addingSpace ? (
                <NewSpaceInput
                  onDone={(slug) => {
                    setAddingSpace(false);
                    if (slug) editor.set('space', slug);
                  }}
                />
              ) : (
                <Select
                  value={space ?? PROJECT_WIDE}
                  onValueChange={(v) => {
                    if (v === NEW_SPACE) return setAddingSpace(true);
                    editor.set('space', v === PROJECT_WIDE ? undefined : v);
                  }}
                >
                  <SelectTrigger aria-label={t('space')} size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PROJECT_WIDE}>{t('projectWide')}</SelectItem>
                    {spaces.map((s) => (
                      <SelectItem key={s.name} value={s.name}>
                        # {s.label || s.name}
                      </SelectItem>
                    ))}
                    {space && !spaceNames.has(space) ? <SelectItem value={space}># {space}</SelectItem> : null}
                    <SelectSeparator />
                    <SelectItem value={NEW_SPACE}>{t('newSpace')}</SelectItem>
                  </SelectContent>
                </Select>
              )
            ) : (
              value(space ? `# ${space}` : t('projectWide'))
            )}
          </SettingRow>
        ) : null}
        <SettingRow label={t('color')} help={t('colorHelp')}>
          {editor ? (
            <AgentColorField value={behavior.color} onChange={(next) => editor.setOc('color', next)} />
          ) : (
            <span className="text-foreground flex items-center gap-2 text-sm sm:justify-end">
              <span className={cn('size-3.5 shrink-0 rounded-sm', face.swatch)} style={face.style} />
              {face.label}
            </span>
          )}
        </SettingRow>
      </EditorSection>

      <EditorSection title={t('inThePicker')}>
        <div className="flex items-center gap-2.5 px-4 py-3">
          <AgentMark slug={agent.name} />
          <span className="text-foreground min-w-0 flex-1 truncate text-sm">{agentDisplayName(agent.name)}</span>
          <span className="text-muted-foreground text-xs">{modeLabel}</span>
        </div>
      </EditorSection>

      <EditorSection title={t('source')}>
        <SettingRow label={t('sourceConfig')}>
          <SourceValue value="kortix.yaml" />
        </SettingRow>
        <SettingRow label={t('sourceKey')}>
          <SourceValue value={`agents.${agent.name}`} />
        </SettingRow>
        <SettingRow label={t('sourceInstructions')}>
          <SourceValue value={sourcePath} />
        </SettingRow>
      </EditorSection>
    </>
  );
}

// ─── The tab ─────────────────────────────────────────────────────────────────

export function AgentOverview({
  agent,
  config,
  block,
  prompt,
  editor,
  sourcePath,
  onAskMyKortix,
  focusInstructions = false,
  showSpace = false,
}: {
  agent: Agent;
  config: ProjectConfigSummary;
  /** The draft (editable) or the served block (read-only). */
  block: AgentConfigBlock;
  /** The instructions; null while a reader's source file loads. */
  prompt: string | null;
  editor?: AgentDraft;
  sourcePath: string;
  onAskMyKortix?: () => void;
  /** Unfold the instructions with the cursor in them (the old Instructions tab link). */
  focusInstructions?: boolean;
  /** Show the Space row. Spaces are Work in progress: pass `useSpacesEnabled(projectId)`. */
  showSpace?: boolean;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  // Editable: the draft alone, so clearing the description shows it cleared.
  const description = (editor ? editor.oc.description : (block.behavior?.description ?? agent.description)) ?? '';
  return (
    // One centered column, the Settings page's shape: the description and the
    // instructions, then the settings below them.
    <EditorSectionStyleProvider value="panel">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <EditorSection title={t('tabOverview')} lead bare>
          <div className="space-y-2">
            <h3 className="text-foreground text-sm font-medium">{tPage('description')}</h3>
            <AboutDescription
              value={description}
              onChange={editor ? (next) => editor.setOc('description', next) : undefined}
              subagent={(editor?.oc.mode ?? block.behavior?.mode) === 'subagent'}
            />
          </div>
        </EditorSection>
        <AgentInstructions
          value={prompt}
          onChange={editor ? (next) => editor.setOc('prompt', next) : undefined}
          onAskMyKortix={onAskMyKortix}
          autoFocus={focusInstructions}
        />
        <OverviewSettings
          agent={agent}
          config={config}
          block={block}
          editor={editor}
          showSpace={showSpace}
          sourcePath={sourcePath}
        />
      </div>
    </EditorSectionStyleProvider>
  );
}
